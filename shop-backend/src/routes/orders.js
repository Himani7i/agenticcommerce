import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { logAudit } from '../audit.js';
import { runPolicyChecks, needsConfirmation, allChecksPassed } from '../policy.js';
import { createRazorpayOrder, createPaymentLink } from '../razorpay.js';

const router = Router();

function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function getProductsById(ids) {
  if (ids.length === 0) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM products WHERE id IN (${placeholders})`).all(...ids);
  return Object.fromEntries(rows.map(r => [r.id, r]));
}

// POST /orders
// body: { session_id, items: [{product_id, qty}], idempotency_key? }
router.post('/', async (req, res) => {
  const { session_id, items, idempotency_key } = req.body;

  if (!session_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'session_id and non-empty items[] required' });
  }

  // Idempotency: replaying the same key returns the existing order instead
  // of creating a duplicate / double-charging.
  if (idempotency_key) {
    const existing = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(idempotency_key);
    if (existing) {
      logAudit({
        session_id, actor: 'system', tool_called: 'create_order',
        input: req.body, decision: 'info',
        explanation: `Idempotency key '${idempotency_key}' already used - returning existing order ${existing.id} instead of creating a duplicate`
      });
      return res.status(200).json({ ...existing, items: JSON.parse(existing.items), idempotent_replay: true });
    }
  }

  const session = getSession(session_id);
  const productsById = getProductsById(items.map(i => i.product_id));
  const totalAmount = items.reduce((sum, it) => sum + (productsById[it.product_id]?.price ?? 0) * it.qty, 0);

  const checks = runPolicyChecks({ session, items, productsById, totalAmount });
  const passed = allChecksPassed(checks);

  if (!passed) {
    const failedCheck = checks.find(c => !c.passed);
    logAudit({
      session_id, actor: session?.actor_type || 'unknown', tool_called: 'create_order',
      input: req.body, policy_checks: checks, decision: 'blocked',
      explanation: `Order blocked: ${failedCheck.reason}`
    });
    return res.status(422).json({
      error: 'policy_check_failed',
      failed_check: failedCheck,
      all_checks: checks,
      suggestion: buildSuggestion(failedCheck)
    });
  }

  const orderId = uuidv4();
  const now = new Date().toISOString();
  const mustConfirm = session.actor_type === 'agent' && needsConfirmation(session, totalAmount);
  const status = mustConfirm ? 'needs_confirmation' : 'created';

  db.prepare(`
    INSERT INTO orders (id, session_id, razorpay_order_id, status, amount, currency, items, idempotency_key, failure_reason, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, 'INR', ?, ?, NULL, ?, ?)
  `).run(orderId, session_id, status, totalAmount, JSON.stringify(items), idempotency_key || null, now, now);

  if (mustConfirm) {
    logAudit({
      session_id, actor: session.actor_type, tool_called: 'create_order',
      input: req.body, policy_checks: checks, decision: 'info',
      explanation: `Order ₹${(totalAmount/100).toFixed(2)} exceeds confirmation threshold ₹${(session.confirmation_threshold/100).toFixed(2)} - paused for explicit confirmation before touching Razorpay`
    });
    return res.status(202).json({
      id: orderId, session_id, status, amount: totalAmount, items, checks,
      message: 'Order requires confirmation before payment. POST /orders/:id/confirm to proceed.'
    });
  }

  await finalizeToRazorpay({ id: orderId, session_id, amount: totalAmount, currency: 'INR', items }, session, checks, res);
});

// POST /orders/:id/confirm - human-in-the-loop approval for over-threshold orders
router.post('/:id/confirm', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });
  if (order.status !== 'needs_confirmation') {
    return res.status(409).json({ error: 'not_awaiting_confirmation', status: order.status });
  }
  const session = getSession(order.session_id);
  const items = JSON.parse(order.items);

  logAudit({
    session_id: order.session_id, actor: 'human', tool_called: 'confirm_order',
    input: { order_id: order.id }, decision: 'allowed',
    explanation: `Order ${order.id} (₹${(order.amount/100).toFixed(2)}) explicitly confirmed - proceeding to payment`
  });

  await finalizeToRazorpay({ ...order, items }, session, [], res);
});

router.get('/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });
  res.json({ ...order, items: JSON.parse(order.items) });
});

// --- helpers ---

async function finalizeToRazorpay(orderRow, session, checks, res) {
  try {
    const rzpOrder = await createRazorpayOrder({
      amount: orderRow.amount,
      currency: orderRow.currency,
      receipt: orderRow.id,
      notes: { session_id: orderRow.session_id, actor_type: session.actor_type }
    });

    const now = new Date().toISOString();
    db.prepare(`UPDATE orders SET razorpay_order_id = ?, status = 'created', updated_at = ? WHERE id = ?`)
      .run(rzpOrder.id, now, orderRow.id);

    db.prepare('UPDATE sessions SET spent = spent + ? WHERE id = ?').run(orderRow.amount, orderRow.session_id);

    let paymentLink = null;
    if (session.actor_type === 'human') {
      const link = await createPaymentLink({
        amount: orderRow.amount,
        currency: orderRow.currency,
        description: `Order ${orderRow.id}`,
        reference_id: orderRow.id
      });
      paymentLink = link.short_url;
    }

    logAudit({
      session_id: orderRow.session_id, actor: session.actor_type, tool_called: 'create_razorpay_order',
      input: { order_id: orderRow.id, amount: orderRow.amount }, policy_checks: checks,
      result: { razorpay_order_id: rzpOrder.id, payment_link: paymentLink },
      decision: 'allowed',
      explanation: `Razorpay order ${rzpOrder.id} created for ₹${(orderRow.amount/100).toFixed(2)}${paymentLink ? ' - payment link generated' : ' - awaiting agent payment capture'}`
    });

    res.status(201).json({ ...orderRow, status: 'created', razorpay_order_id: rzpOrder.id, payment_link: paymentLink, checks });
  } catch (err) {
    db.prepare(`UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?`)
      .run(err.message, new Date().toISOString(), orderRow.id);

    logAudit({
      session_id: orderRow.session_id, actor: 'system', tool_called: 'create_razorpay_order',
      input: { order_id: orderRow.id }, decision: 'error',
      explanation: `Razorpay order creation failed: ${err.message}`
    });

    res.status(502).json({ error: 'razorpay_error', message: err.message, order_id: orderRow.id });
  }
}

function buildSuggestion(failedCheck) {
  if (failedCheck.name === 'stock_available') return 'This item is out of stock right now. Try a different product or reduce quantity.';
  if (failedCheck.name === 'budget_cap') return 'Reduce the order amount or increase the session budget to proceed.';
  if (failedCheck.name === 'sku_agent_purchasable') return 'This product requires human checkout - it is not enabled for AI buyers.';
  if (failedCheck.name === 'category_allowlist') return 'Choose an item from an allowed category for this session.';
  if (failedCheck.name === 'valid_product_ids') return 'That product ID does not exist. Try searching the catalog again.';
  return 'Adjust the order and try again.';
}

export default router;