import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import webhookRoutes from './routes/webhooks.js';
import orderRoutes from './routes/orders.js';
import catalogRoutes from './routes/catalog.js';
import sessionRoutes from './routes/sessions.js';
import auditRoutes from './routes/audit.js';
import paymentRoutes from './routes/payments.js';
import crosssellRoutes from './routes/crosssell.js';

const app = express();
app.use(cors());
app.use('/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ name: 'Agentic Commerce Demo Shop', mode: 'razorpay-test-mode' });
});
app.use('/orders', orderRoutes);
app.use('/catalog', catalogRoutes);
app.use('/sessions', sessionRoutes);
app.use('/audit-log', auditRoutes);
app.use('/payments', paymentRoutes);
app.use('/catalog', crosssellRoutes);
app.use('/catalog', catalogRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Shop backend running on http://localhost:${PORT}`);
});