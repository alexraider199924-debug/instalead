import { registerUser, loginUser } from '../src/services/authService.js';

const email = process.argv[2];
const password = process.argv[3];
if (!email || !password) {
  console.error('Usage: node scripts/create-admin.mjs <email> <password>');
  process.exit(1);
}

const { getAuthDB } = await import('../src/db/authDb.js');
const db = await getAuthDB();
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
let user;
if (!existing) {
  ({ user } = await registerUser(email, password));
} else {
  db.prepare('UPDATE users SET role = \'admin\', banned = 0 WHERE id = ?').run(existing.id);
  user = db.prepare('SELECT id,email,role,banned,workspace FROM users WHERE id = ?').get(existing.id);
}
console.log(JSON.stringify(user, null, 2));
