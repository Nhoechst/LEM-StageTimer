import { pbkdf2Sync, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const tokenHash = value => createHash('sha256').update(value).digest('hex');
export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return `pbkdf2$210000$${salt}$${pbkdf2Sync(pin, salt, 210000, 32, 'sha256').toString('hex')}`;
}
function verifyPin(pin, hash) {
  const [algorithm, iterations, salt, digest] = hash.split('$');
  if (algorithm !== 'pbkdf2' || iterations !== '210000' || !salt || !/^[a-f0-9]{64}$/.test(digest ?? '')) return false;
  return timingSafeEqual(Buffer.from(digest, 'hex'), pbkdf2Sync(pin, salt, 210000, 32, 'sha256'));
}

export function operatorAuth(db, fail) {
  db.exec(`CREATE TABLE IF NOT EXISTS operator_sessions (
    id TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS operator_throttle (
    id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const stored = db.prepare('SELECT pin FROM settings WHERE id = 1').get().pin;
  if (/^\d{4,6}$/.test(stored)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT pin FROM settings WHERE id = 1').get().pin;
      if (/^\d{4,6}$/.test(current)) {
        db.prepare('UPDATE settings SET pin = ? WHERE id = 1').run(hashPin(current));
        db.exec('DELETE FROM operator_sessions');
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const configured = () => db.prepare('SELECT pin FROM settings WHERE id = 1').get().pin !== '';
  const status = (id, token) => ({
    configured: configured(),
    authorized: !configured() || !!db.prepare('SELECT 1 FROM operator_sessions WHERE id = ? AND token = ? AND expires > ?')
      .get(id, tokenHash(token), Date.now()),
  });
  const action = (payload, id, token, address) => {
    if (!/^[a-f0-9]{32}$/.test(id) || !payload || !['bootstrap', 'unlock', 'lock', 'configure'].includes(payload.action)) fail(400, 'Invalid operator request.');
    if (payload.action === 'bootstrap') return { auth: status(id, token), token };
    db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      db.prepare('DELETE FROM operator_sessions WHERE expires <= ?').run(now);
      db.prepare('DELETE FROM operator_throttle WHERE expires <= ?').run(now);
      if (payload.action === 'lock') {
        db.prepare('DELETE FROM operator_sessions WHERE id = ?').run(id);
        db.exec('COMMIT');
        return { auth: status(id, token), token };
      }
      if (payload.action === 'configure' && !status(id, token).authorized) fail(401, 'Enter the PIN to authorize this window first.');
      if (typeof payload.pin !== 'string' || !/^(?:|\d{4,6})$/.test(payload.pin) ||
          (payload.action === 'unlock' && !payload.pin)) fail(400, 'Use a numeric PIN with 4–6 digits.');
      if (payload.action === 'unlock') {
        const key = tokenHash(address);
        const throttle = db.prepare('SELECT attempts FROM operator_throttle WHERE id = ?').get(key);
        if (throttle?.attempts >= 5) fail(429, 'Too many attempts. Wait one minute before retrying.');
        db.prepare(`INSERT INTO operator_throttle VALUES (?, 1, ?)
          ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1`).run(key, now + 60000);
        if (!configured() || !verifyPin(payload.pin, db.prepare('SELECT pin FROM settings WHERE id = 1').get().pin)) {
          db.exec('COMMIT');
          fail(401, 'That PIN is not correct.');
        }
        db.prepare('DELETE FROM operator_throttle WHERE id = ?').run(key);
      } else {
        db.prepare('UPDATE settings SET pin = ? WHERE id = 1').run(payload.pin ? hashPin(payload.pin) : '');
        db.exec('DELETE FROM operator_sessions');
      }
      const nextToken = payload.action === 'configure' ? randomBytes(32).toString('hex') : token;
      db.prepare('INSERT OR REPLACE INTO operator_sessions VALUES (?, ?, ?)').run(id, tokenHash(nextToken), now + 12 * 3600000);
      db.exec('COMMIT');
      return { auth: status(id, nextToken), token: nextToken };
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  return { status, action };
}
