// Usage: node test-webhook.js <razorpay_order_id> <amount_in_paise> [--bad-signature]
import crypto from 'crypto';

const WEBHOOK_SECRET = 'test_webhook_secret_change_me'; // must match your .env value exactly

const [, , orderId, amountArg, flag] = process.argv;

if (!orderId || !amountArg) {
  console.error('Usage: node test-webhook.js <razorpay_order_id> <amount_in_paise> [--bad-signature]');
  process.exit(1);
}

const payload = {
  event: 'payment.captured',
  payload: {
    payment: {
      entity: {
        id: `pay_test_${Date.now()}`,
        order_id: orderId,
        amount: parseInt(amountArg, 10),
        status: 'captured'
      }
    }
  }
};

const body = JSON.stringify(payload);
const secretToUse = flag === '--bad-signature' ? 'deliberately_wrong_secret' : WEBHOOK_SECRET;
const signature = crypto.createHmac('sha256', secretToUse).update(body).digest('hex');

const res = await fetch('http://localhost:4000/webhooks/razorpay', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
  body
});

console.log('HTTP status:', res.status);
console.log(await res.json());