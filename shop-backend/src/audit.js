import { v4 as uuidv4 } from 'uuid';
import db from './db.js';

const insertStmt = db.prepare(`
  INSERT INTO audit_log (id, timestamp, session_id, actor, tool_called, input, policy_checks, result, decision, explanation)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * Log one auditable event. Every route that touches money or an agent
 * decision must call this - it's the single source of truth for
 * "why did the system do X".
 */
export function logAudit({ session_id = null, actor, tool_called, input = {}, policy_checks = [], result = {}, decision, explanation }) {
  const id = uuidv4();
  const timestamp = new Date().toISOString();

  insertStmt.run(
    id,
    timestamp,
    session_id,
    actor,
    tool_called,
    JSON.stringify(input),//store as json strings for sqlite
    JSON.stringify(policy_checks),
    JSON.stringify(result),
    decision,
    explanation
  );

  return { id, timestamp, session_id, actor, tool_called, input, policy_checks, result, decision, explanation };
}

export function getAuditLog({ session_id = null, limit = 200 } = {}) {
  const rows = session_id
    ? db.prepare('SELECT * FROM audit_log WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?').all(session_id, limit)
    : db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?').all(limit);

  return rows.map(r => ({
    ...r,
    input: JSON.parse(r.input || '{}'),
    policy_checks: JSON.parse(r.policy_checks || '[]'),
    result: JSON.parse(r.result || '{}')
  }));
}