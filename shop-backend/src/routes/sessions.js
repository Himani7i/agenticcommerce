import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { logAudit } from '../audit.js';

const router = Router();

// POST /sessions
// body: { actor_type: 'agent'|'human', actor_name, budget_limit (paise),
//         allowed_categories?: string[], confirmation_threshold?: paise }
router.post('/', (req, res) => {
  const { actor_type, actor_name, budget_limit, allowed_categories, confirmation_threshold } = req.body;

  if (!actor_type || !budget_limit) {
    return res.status(400).json({ error: 'actor_type and budget_limit are required' });
  }

  const id = uuidv4();
  const created_at = new Date().toISOString();

  db.prepare(`
    INSERT INTO sessions (id, actor_type, actor_name, budget_limit, spent, allowed_categories, confirmation_threshold, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    id,
    actor_type,
    actor_name || null,
    budget_limit,
    allowed_categories ? JSON.stringify(allowed_categories) : null,
    confirmation_threshold ?? null,
    created_at
  );

  logAudit({
    session_id: id,
    actor: actor_type,
    tool_called: 'create_session',
    input: req.body,
    decision: 'allowed',
    explanation: `New ${actor_type} session for ${actor_name || 'unnamed buyer'}: budget ₹${(budget_limit/100).toFixed(2)}${confirmation_threshold ? `, confirmation required above ₹${(confirmation_threshold/100).toFixed(2)}` : ''}`
  });

  res.status(201).json({ id, actor_type, actor_name, budget_limit, spent: 0, allowed_categories, confirmation_threshold, created_at });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ ...row, allowed_categories: row.allowed_categories ? JSON.parse(row.allowed_categories) : null });
});

export default router;