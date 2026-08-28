import db from './src/db.js';

const updates = [
  ['TSHIRT001', '100% cotton crewneck t-shirt, breathable and lightweight, great for everyday casual wear in warm weather.'],
  ['TSHIRT002', 'Bold printed cotton tee with a relaxed streetwear cut, perfect for casual outings.'],
  ['SOCKS001', 'Breathable cotton-blend ankle socks, pack of 3, comfortable for daily wear and light exercise.'],
  ['SHOES001', 'Lightweight running shoes built for daily training, jogging, and everyday exercise.'],
  ['CAP001', 'Adjustable cotton twill baseball cap, a great sun-protection accessory for sunny outdoor days.'],
  ['JACKET001', 'Genuine leather jacket, warm and durable, ideal for cold weather, winter trips, and layering in chilly conditions.'],
];

const stmt = db.prepare('UPDATE products SET description = ? WHERE id = ?');
for (const [id, desc] of updates) {
  stmt.run(desc, id);
}
console.log(`Updated descriptions for ${updates.length} products.`);