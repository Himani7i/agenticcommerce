import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { logAudit } from '../audit.js';

const router = Router();
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

// IMPORTANT: this route is mounted with express.raw() in server.js, so
// req.body here is a raw Buffer, NOT parsed JSON.HMAC
// verification needs the exact original bytes Razorpay signed.
router.post('/razorpay', (req, res) => {
  const signature = req.headers['x-razorpay-signature'];

  if (!WEBHOOK_SECRET) {
    console.warn('RAZORPAY_WEBHOOK_SECRET not set - rejecting webhook');
    return res.status(500).json({ error: 'webhook_secret_not_configured' });
  }

  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('hex');

  if (expected !== signature) {
    logAudit({
      actor: 'system', tool_called: 'webhook_razorpay', decision: 'blocked',
      input: {}, explanation: 'Webhook signature verification FAILED - payload rejected. Possible tampering or misconfigured secret.'
    });
    return res.status(400).json({ error: 'invalid_signature' });
  }

  const event = JSON.parse(req.body.toString('utf8'));
  const paymentEntity = event?.payload?.payment?.entity;

  if (!paymentEntity) {
    return res.status(200).json({ status: 'ignored', reason: 'no payment entity in event' });
  }

  const paymentId = paymentEntity.id;
  const razorpayOrderId = paymentEntity.order_id;
  const capturedAmount = paymentEntity.amount;

  const order = db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(razorpayOrderId);

  if (!order) {
    logAudit({
      actor: 'system', tool_called: 'webhook_razorpay', decision: 'error',
      input: { razorpayOrderId }, explanation: `Webhook referenced unknown razorpay_order_id ${razorpayOrderId} - no matching local order`
    });
    return res.status(200).json({ status: 'ignored', reason: 'no matching local order' });
  }

  // Idempotency: Razorpay can send the same webhook more than once.
  if (order.status === 'paid') {
    logAudit({
      session_id: order.session_id, actor: 'system', tool_called: 'webhook_razorpay', decision: 'info',
      input: { paymentId }, explanation: `Duplicate webhook for already-paid order ${order.id} - ignored, no double action taken`
    });
    return res.status(200).json({ status: 'already_processed' });
  }

  //the amount Razorpay actually captured must exactly
  // match our own order record. 
  if (capturedAmount !== order.amount) {
    db.prepare(`UPDATE orders SET status = 'flagged_for_review', failure_reason = ?, updated_at = ? WHERE id = ?`)
      .run(`Amount mismatch: expected ${order.amount}, Razorpay captured ${capturedAmount}`, new Date().toISOString(), order.id);

    logAudit({
      session_id: order.session_id, actor: 'system', tool_called: 'webhook_razorpay', decision: 'error',
      input: { paymentId, capturedAmount, expected: order.amount },
      explanation: `Amount mismatch on order ${order.id}: expected ₹${(order.amount/100).toFixed(2)}, Razorpay captured ₹${(capturedAmount/100).toFixed(2)}. Order flagged for review - NOT marked paid.`
    });
    return res.status(200).json({ status: 'flagged', reason: 'amount_mismatch' });
  }

  db.prepare(`UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), order.id);

  const items = JSON.parse(order.items);
  const decrement = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
  for (const it of items) decrement.run(it.qty, it.product_id);

  logAudit({
    session_id: order.session_id, actor: 'system', tool_called: 'webhook_razorpay', decision: 'allowed',
    input: { paymentId, razorpayOrderId }, result: { amount: capturedAmount },
    explanation: `Razorpay webhook verified and confirmed payment ${paymentId} for order ${order.id} (₹${(capturedAmount/100).toFixed(2)}) - marked paid`
  });

  res.status(200).json({ status: 'processed' });
});

export default router;