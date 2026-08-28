import { Router } from 'express';
import db from '../db.js';
import { CROSS_SELL_MAP } from '../config.js';

const router = Router();

// GET /catalog/:id/crosssell - returns complementary product(s) with LIVE
// details (price/stock/policy)
router.get('/:id/crosssell', (req, res) => {
  const relatedIds = CROSS_SELL_MAP[req.params.id] || [];
  if (relatedIds.length === 0) return res.json({ suggestions: [] });

  const placeholders = relatedIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM products WHERE id IN (${placeholders})`).all(...relatedIds);

  const suggestions = rows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    price: row.price,
    price_display: `₹${(row.price / 100).toFixed(2)}`,
    stock: row.stock,
    in_stock: row.stock > 0,
    policy: { agent_purchasable: !!row.agent_purchasable, max_agent_price: row.max_agent_price }
  }));

  res.json({ suggestions });
});

export default router;