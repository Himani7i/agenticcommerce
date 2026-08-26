import Razorpay from 'razorpay';
import crypto from 'crypto';

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

let client = null;
function getClient() {
  if (!KEY_ID || !KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set in environment (.env)');
  }
  if (!client) client = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
  return client;
}

export async function createRazorpayOrder({ amount, currency = 'INR', receipt, notes = {} }) {
  const rzp = getClient();
  return rzp.orders.create({ amount, currency, receipt, notes, payment_capture: 1 });
}

export async function createPaymentLink({ amount, currency = 'INR', description, reference_id, notes = {} }) {
  const rzp = getClient();
  return rzp.paymentLink.create({ amount, currency, description, reference_id, notes, reminder_enable: false });
}

export function verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const body = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = crypto.createHmac('sha256', KEY_SECRET).update(body).digest('hex');
  return expected === razorpay_signature;
}