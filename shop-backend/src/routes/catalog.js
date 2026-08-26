import { Router } from 'express';
import db from '../db.js';

const router = Router();

// GET /catalog - agent-readable, structured, includes purchasability + limits
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM products').all();
  res.json({ merchant: 'Demo Shop', currency: 'INR', products: rows.map(toAgentReadable) });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(toAgentReadable(row));
});

function toAgentReadable(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    price: row.price,
    currency: row.currency,
    price_display: `₹${(row.price / 100).toFixed(2)}`,
    stock: row.stock,
    in_stock: row.stock > 0,
    policy: {
      agent_purchasable: !!row.agent_purchasable,//convert sqlite's stored 0/1 integer into true/false(while api responsing)
      max_agent_price: row.max_agent_price
    }
  };
}

export default router;