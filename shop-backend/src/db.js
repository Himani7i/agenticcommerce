import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, 'shop.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  price INTEGER NOT NULL,          -- paise (INR smallest unit)
  currency TEXT DEFAULT 'INR',
  stock INTEGER NOT NULL DEFAULT 0,
  agent_purchasable INTEGER DEFAULT 1,   -- 0/1
  max_agent_price INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,        -- 'human' | 'agent'
  actor_name TEXT,
  budget_limit INTEGER NOT NULL,   -- paise
  spent INTEGER NOT NULL DEFAULT 0,
  allowed_categories TEXT,         -- JSON array or NULL
  confirmation_threshold INTEGER,  -- paise or NULL
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  razorpay_order_id TEXT,
  status TEXT NOT NULL,            -- created | needs_confirmation | paid | failed
  amount INTEGER NOT NULL,
  currency TEXT DEFAULT 'INR',
  items TEXT NOT NULL,             -- JSON array
  idempotency_key TEXT UNIQUE,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  session_id TEXT,
  actor TEXT,
  tool_called TEXT NOT NULL,
  input TEXT,           -- JSON
  policy_checks TEXT,   -- JSON array
  result TEXT,          -- JSON
  decision TEXT NOT NULL,
  explanation TEXT NOT NULL
);
`);

// Seed the catalog
const { c: productCount } = db.prepare('SELECT COUNT(*) as c FROM products').get();
if (productCount === 0) {
  const insert = db.prepare(`
    INSERT INTO products (id, name, description, category, price, currency, stock, agent_purchasable, max_agent_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seed = [
    ['TSHIRT001', 'Classic Cotton T-Shirt', '100% cotton, unisex fit', 'apparel', 79900, 'INR', 25, 1, 100000],
    ['TSHIRT002', 'Graphic Print Tee', 'Printed cotton tee, streetwear cut', 'apparel', 99900, 'INR', 15, 1, 100000],
    ['SOCKS001', 'Ankle Socks (Pack of 3)', 'Breathable cotton-blend socks', 'apparel', 19900, 'INR', 40, 1, 25000],
    ['SHOES001', 'Running Shoes', 'Lightweight daily trainer', 'footwear', 349900, 'INR', 8, 1, 400000],
    ['CAP001', 'Baseball Cap', 'Adjustable strap, cotton twill', 'accessories', 49900, 'INR', 0, 1, 60000], // out of stock on purpose - for testing later
    ['JACKET001', 'Premium Leather Jacket', 'Genuine leather, limited stock', 'apparel', 899900, 'INR', 5, 0, null] // not agent-purchasable on purpose
  ];
  for (const p of seed) insert.run(...p);
  console.log(`Seeded ${seed.length} products.`);
}

export default db;