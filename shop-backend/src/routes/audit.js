import { Router } from 'express';
import { getAuditLog } from '../audit.js';

const router = Router();

// GET /audit-log?session_id=xxx
router.get('/', (req, res) => {
  const { session_id, limit } = req.query;
  res.json(getAuditLog({ session_id, limit: limit ? parseInt(limit) : 200 }));
});

export default router;