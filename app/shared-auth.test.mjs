import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer, createStore } from './server.mjs';

const hasPHP = spawnSync('php', ['-r', 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);']).status === 0;
const state = { revision: 0, shows: [], settings: { pin: '' } };

async function serve(t, env) {
  const child = spawn('php', ['-S', '127.0.0.1:0', '-t', path.resolve('php')], {
    env: { ...process.env, DB_PATH: '', STATE_PATH: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(async () => { child.kill(); await once(child, 'exit'); });
  const base = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('PHP startup timed out: ' + log)), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  return base;
}

function client(base, id = 'a'.repeat(32), cookies = new Map()) {
  const request = async (method = 'GET', payload, extra = {}) => {
    const response = await fetch(`${base}/api.php`, {
      method, headers: { Origin: base, 'Content-Type': 'application/json', 'X-Operator-ID': id,
        Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...extra },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [key, value] = cookie.split(';')[0].split('=');
      if (value === 'deleted' || /max-age=0/i.test(cookie)) cookies.delete(key);
      else cookies.set(key, value);
    }
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  request.cookies = cookies;
  return request;
}

function directory(t) {
  const dir = path.resolve(`.test-shared-auth-${randomUUID()}`);
  mkdirSync(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedAccounts(authFile) {
  const seeded = spawnSync('php', ['-r', `
    require $argv[1];
    $accounts = \\Lem\\SharedAccounts::open($argv[2], true);
    $accounts->pdo->prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      ->execute(["operator", password_hash("test-only-password", PASSWORD_DEFAULT)]);
  `, path.resolve('php/SharedAccounts.php'), authFile], { encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
}

test('PHP shared login gates all writes without a PIN, then requires account and PIN; revokes changed/deleted users',
  { skip: !hasPHP }, async t => {
    const dir = directory(t);
    const authFile = path.join(dir, 'users.db');
    // Synthetic accounts only; never read or copy a deployment database.
    seedAccounts(authFile);
    const dataDir = path.join(dir, 'timer');
    const base = await serve(t, { LEM_DATA_DIR: dataDir, LEM_AUTH_DB: authFile });
    const request = client(base);
    const get = await request();
    assert.equal(get.status, 200);
    assert.equal(get.body.auth.authorized, false);
    assert.equal(get.body.account.enabled, true);
    assert.match(get.headers.get('set-cookie'), /lem_stagetimer_account=.*HttpOnly.*SameSite=Strict/i);
    const csrf = get.body.account.csrf;
    for (const action of ['bootstrap', 'unlock', 'configure', 'lock']) {
      assert.equal((await request('POST', { action, pin: '2468' })).status, 401);
    }
    assert.equal((await request('PUT', state)).status, 401);
    assert.equal(existsSync(path.join(dataDir, 'lem-time.db.bak')), false);
    const login = { action: 'login', username: 'OPERATOR', password: 'test-only-password', csrf };
    assert.equal((await request('POST', { ...login, csrf: 'bad' })).status, 403);
    assert.equal((await request('POST', login, { Origin: 'https://other.invalid' })).status, 403);
    assert.equal((await request('POST', { ...login, password: 'wrong' })).status, 401);
    assert.equal((await request('POST', login)).status, 200);
    assert.equal((await request()).body.auth.authorized, true);
    assert.equal((await request('PUT', state)).status, 200);
    assert.equal((await request('POST', { action: 'configure', pin: '2468' })).status, 200);
    const otherWindow = client(base, 'b'.repeat(32));
    assert.equal((await otherWindow('PUT', { ...state, revision: 1 })).status, 401);
    const accountDB = new DatabaseSync(authFile);
    t.after(() => accountDB.close());
    const afterLogin = (await request()).body.account;
    assert.equal((await request('POST', { action: 'logout', csrf: 'bad' })).status, 403);
    assert.equal((await request('POST', { action: 'logout', csrf: afterLogin.csrf })).status, 200);
    assert.equal((await request('PUT', { ...state, revision: 1 })).status, 401);
    const signedOut = (await request()).body;
    assert.equal((await request('POST', { ...login, csrf: signedOut.account.csrf })).status, 200);
    const pinLocked = (await request()).body;
    assert.equal(pinLocked.auth.configured, true);
    assert.equal(pinLocked.auth.authorized, false);
    assert.equal((await request('PUT', { ...state, revision: 1 })).status, 401);
    assert.equal((await request('POST', { action: 'unlock', pin: '1111' })).status, 401);
    assert.equal((await request('POST', { action: 'bootstrap' })).status, 200);
    assert.equal((await request('POST', { action: 'unlock', pin: '2468' })).status, 200);
    assert.equal((await request('PUT', { ...state, revision: 1 })).status, 200);
    assert.equal(existsSync(path.join(dataDir, 'lem-time.db.bak')), true);
    const sessions = path.join(dataDir, 'sessions');
    let expired = 0;
    for (const file of readdirSync(sessions)) {
      const filename = path.join(sessions, file);
      const content = readFileSync(filename, 'utf8');
      if (content.includes('lem_account|')) {
        writeFileSync(filename, content.replace(/"expires";i:\d+/, '"expires";i:1'));
        expired++;
      }
    }
    assert.equal(expired, 1);
    request.cookies.delete('lem_sso'); // the shared log-in cookie runs out at the same time
    const expiredAccount = (await request()).body.account;
    assert.equal(expiredAccount.user, null);
    assert.equal((await request('PUT', { ...state, revision: 2 })).status, 401);
    assert.equal((await request('POST', { ...login, csrf: expiredAccount.csrf })).status, 200);
    const hash = accountDB.prepare('SELECT password_hash FROM users').get().password_hash;
    accountDB.prepare('UPDATE users SET password_hash = ?').run('changed');
    assert.equal((await request()).body.account.user, null);
    assert.equal((await request('PUT', { ...state, revision: 2 })).status, 401);
    accountDB.prepare('UPDATE users SET password_hash = ?').run(hash);
    const again = (await request()).body.account;
    assert.equal((await request('POST', { ...login, csrf: again.csrf })).status, 200);
    accountDB.exec('DELETE FROM users');
    assert.equal((await request()).body.account.user, null);
    assert.equal((await request('POST', { action: 'configure', pin: '' })).status, 401);
    accountDB.prepare('INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, 1)')
      .run('operator', hash);
    const temporary = (await request()).body.account;
    const forced = await request('POST', { ...login, csrf: temporary.csrf });
    assert.equal(forced.status, 403);
    assert.match(forced.body.error, /Dashboard/);
    const restarted = await serve(t, { LEM_DATA_DIR: dataDir, LEM_AUTH_DB: authFile });
    const persisted = await client(restarted)();
    assert.equal(persisted.body.revision, 2);
    assert.equal(persisted.body.auth.configured, true);
    assert.equal(persisted.body.auth.authorized, false);
  });

test('PHP shared login follows log-ins and log-outs of the other LEM apps on the same address (single sign-on)',
  { skip: !hasPHP }, async t => {
    const dir = directory(t);
    const authFile = path.join(dir, 'users.db');
    seedAccounts(authFile);
    // Two instances stand in for two LEM apps on different ports of one address: the browser
    // sends the same lem_sso cookie to both.
    const browser = new Map();
    const here = client(await serve(t, { LEM_DATA_DIR: path.join(dir, 'here'), LEM_AUTH_DB: authFile }), 'a'.repeat(32), browser);
    const other = client(await serve(t, { LEM_DATA_DIR: path.join(dir, 'other'), LEM_AUTH_DB: authFile }), 'a'.repeat(32), new Map());
    const login = { action: 'login', username: 'OPERATOR', password: 'test-only-password' };
    assert.equal((await here()).body.account.user, null);
    assert.equal((await here('POST', { ...login, csrf: (await here()).body.account.csrf })).status, 200);
    const shared = browser.get('lem_sso');
    assert.match(shared ?? '', /^1\./);
    other.cookies.set('lem_sso', shared);
    const followed = await other();
    assert.equal(followed.body.account.user?.username, 'operator');
    assert.equal(followed.body.auth.authorized, true); // no installation PIN set here yet
    assert.equal((await other('PUT', state)).status, 200);
    other.cookies.set('lem_sso', shared.slice(0, -1) + (shared.endsWith('0') ? '1' : '0'));
    assert.equal((await other()).body.account.user, null);
    other.cookies.set('lem_sso', shared);
    assert.equal((await other()).body.account.user?.username, 'operator');
    const out = await other('POST', { action: 'logout', csrf: (await other()).body.account.csrf });
    assert.equal(out.status, 200);
    assert.equal(other.cookies.has('lem_sso'), false);
    assert.equal((await here()).body.account.user, null); // logged out of every app
    assert.equal((await here('PUT', state)).status, 401);
    browser.delete('lem_sso');
    const temporary = new DatabaseSync(authFile);
    t.after(() => temporary.close());
    temporary.prepare('UPDATE users SET must_change_password = 1').run();
    assert.equal((await here('POST', { ...login, csrf: (await here()).body.account.csrf })).status, 403);
    assert.equal(browser.has('lem_sso'), false);
  });

test('shared mode defers legacy imports/backups until account login and preserves the imported PIN',
  { skip: !hasPHP }, async t => {
    const dir = directory(t);
    const authFile = path.join(dir, 'users.db');
    seedAccounts(authFile);
    const dataDir = path.join(dir, 'timer');
    mkdirSync(dataDir);
    const legacy = JSON.stringify({ ...state, initialized: true, revision: 7, settings: { pin: '2468' } });
    writeFileSync(path.join(dataDir, 'lem-time.json'), legacy);
    const request = client(await serve(t, { LEM_DATA_DIR: dataDir, LEM_AUTH_DB: authFile }));
    const first = await request();
    assert.equal(first.body.initialized, false);
    assert.equal(existsSync(path.join(dataDir, 'lem-time.db.bak')), false);
    assert.equal((await request('POST', { action: 'login', username: 'operator',
      password: 'test-only-password', csrf: first.body.account.csrf })).status, 200);
    const imported = (await request()).body;
    assert.equal(imported.revision, 7);
    assert.equal(imported.auth.configured, true);
    assert.equal(imported.auth.authorized, false);
    assert.equal((await request('PUT', { ...state, revision: 7 })).status, 401);
    assert.equal(readFileSync(path.join(dataDir, 'lem-time.json'), 'utf8'), legacy);
    assert.equal(existsSync(path.join(dataDir, 'lem-time.db.bak')), true);
  });

test('missing/invalid shared DB fails closed while public reads stay available; relative data directory rejected',
  { skip: !hasPHP }, async t => {
    const dir = directory(t);
    const authFile = path.join(dir, 'missing.db');
    const base = await serve(t, { LEM_DATA_DIR: path.join(dir, 'timer'), LEM_AUTH_DB: authFile });
    const request = client(base);
    const result = await request();
    assert.equal(result.status, 200);
    assert.equal(result.body.auth.authorized, false);
    assert.match(result.body.account.error, /unavailable/);
    assert.equal((await request('PUT', state)).status, 503);
    assert.equal((await request('POST', { action: 'configure', pin: '2468' })).status, 503);
    assert.equal(existsSync(authFile), false);
    const malformed = new DatabaseSync(authFile);
    malformed.exec('CREATE TABLE lem_auth_schema (version INTEGER); INSERT INTO lem_auth_schema VALUES (99)');
    malformed.close();
    assert.equal((await request('PUT', state)).status, 503);
    const relative = await serve(t, { LEM_DATA_DIR: 'relative', LEM_AUTH_DB: '' });
    assert.equal((await client(relative)()).status, 500);
  });

test('Node refuses shared mode even with a supplied store; supports absolute persistent data directory', t => {
  const dir = directory(t);
  const original = { auth: process.env.LEM_AUTH_DB, data: process.env.LEM_DATA_DIR };
  t.after(() => {
    for (const [name, value] of [['LEM_AUTH_DB', original.auth], ['LEM_DATA_DIR', original.data]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.LEM_AUTH_DB = path.join(dir, 'users.db');
  assert.throws(() => createServer({ store: {} }), /requires the PHP backend/);
  assert.throws(() => createStore(), /requires the PHP backend/);
  delete process.env.LEM_AUTH_DB;
  process.env.LEM_DATA_DIR = dir;
  const store = createStore();
  store.close();
  assert.equal(existsSync(path.join(dir, 'lem-time.db')), true);
  process.env.LEM_DATA_DIR = 'relative';
  assert.throws(() => createStore(), /must be absolute/);
});
