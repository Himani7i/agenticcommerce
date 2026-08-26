import { Router } from 'express';
import db from '../db.js';
import { logAudit } from '../audit.js';
import { verifyPaymentSignature } from '../razorpay.js';

const router = Router();

// POST /payments/verify - the REAL flow, for a HUMAN paying via Checkout.js /
// Payment Link. Verifies Razorpay's HMAC signature server-side before ever
// marking an order paid - never trusts an unsigned "it worked" claim.
router.post('/verify', (req, res) => {
  const { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
  if (!order) return res.status(404).json({ error: 'not_found' });

  const valid = verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });

  if (!valid) {
    logAudit({
      session_id: order.session_id, actor: 'system', tool_called: 'verify_payment',
      input: { order_id }, decision: 'blocked',
      explanation: `Signature verification FAILED for order ${order_id} - payment not marked as paid`
    });
    return res.status(400).json({ error: 'invalid_signature' });
  }

  markOrderPaid(order);
  res.json({ status: 'paid', order_id });
});

// POST /payments/:orderId/simulate
// TEST-MODE ONLY. Razorpay (like any PCI-compliant processor) doesn't allow a
// raw server-to-server card charge without a tokenized payment method or a
// human completing Checkout - that's the exact gap AP2/ACP/UAP protocols are
// trying to standardize for AI buyers. This simulates the OUTCOME of that
// final leg, clearly logged as a simulation so it's never mistaken for a
// real capture in the audit trail.
// body: { outcome: 'success' | 'insufficient_balance' | 'declined' }
router.post('/:orderId/simulate', (req, res) => {
  const { outcome = 'success' } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'not_found' });
  if (order.status !== 'created') {
    return res.status(409).json({ error: 'order_not_awaiting_payment', status: order.status });
  }

  if (outcome === 'success') {
    markOrderPaid(order);
    logAudit({
      session_id: order.session_id, actor: 'system', tool_called: 'simulate_payment',
      input: { order_id: order.id, outcome }, decision: 'allowed',
      explanation: `[TEST-MODE SIMULATION] Payment for order ${order.id} (₹${(order.amount/100).toFixed(2)}) marked successful. Real card capture requires Razorpay Checkout / a tokenized payment method - not simulated here.`
    });
    return res.json({ status: 'paid', order_id: order.id, simulated: true });
  }

  const reason = outcome === 'insufficient_balance'
    ? 'Insufficient balance on the payment method'
    : 'Payment declined by bank/issuer';

  db.prepare(`UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?`)
    .run(reason, new Date().toISOString(), order.id);
  db.prepare('UPDATE sessions SET spent = spent - ? WHERE id = ?').run(order.amount, order.session_id);

  logAudit({
    session_id: order.session_id, actor: 'system', tool_called: 'simulate_payment',
    input: { order_id: order.id, outcome }, decision: 'error',
    explanation: `[TEST-MODE SIMULATION] Payment failed for order ${order.id}: ${reason}. Budget reservation released; agent may retry with a different item or payment method.`
  });

  res.status(402).json({
    error: 'payment_failed',
    reason,
    order_id: order.id,
    suggestion: 'Try a different payment method, or a lower-cost item if this was a balance issue.'
  });
});

function markOrderPaid(order) {
  db.prepare(`UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), order.id);

  const items = JSON.parse(order.items);
  const decrement = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
  for (const it of items) decrement.run(it.qty, it.product_id);
}

export default router;