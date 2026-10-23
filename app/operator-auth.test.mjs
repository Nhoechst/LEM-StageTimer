import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from './server.mjs';
import { timerCommands } from './lib/sync.js';

const hasPHP = spawnSync('php', ['-r', 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);']).status === 0;
async function serve(backend, filename) {
  if (backend === 'Node') {
    const server = createServer({ dbPath: filename });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}/api/state`,
      close: () => new Promise(resolve => server.close(resolve)) };
  }
  const child = spawn('php', ['-S', '127.0.0.1:0', '-t', path.resolve('php')], {
    env: { ...process.env, DB_PATH: filename, STATE_PATH: path.join(path.dirname(filename), 'lem-time.json') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const base = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stderr.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
  });
  return { url: `${base}/api.php`, close: async () => { child.kill(); await once(child, 'exit'); } };
}

const initial = {
  initialized: true, revision: 7, settings: { pin: '2468' }, shows: [{
    id: 'show', title: 'Show', active: 'cue', cues: [{ id: 'cue', name: 'Timer', duration: 600 }],
    left: 600, status: 'Running', logoOn: false, templateId: 'bayer-blue',
  }],
};
function client(server, id) {
  let cookie = '';
  const request = async (method, data, extra = {}) => {
    const response = await fetch(server.url, {
      method, headers: { Origin: new URL(server.url).origin, 'Content-Type': 'application/json',
        'X-Operator-ID': id, Cookie: cookie, ...extra },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { response, body: await response.json() };
  };
  return { request, get: () => request('GET'), cookie: () => cookie,
    action: (action, pin) => request('POST', { action, pin }) };
}

for (const backend of ['Node', 'PHP']) {
  test(`${backend} enforces independent PIN sessions, private migration, revocation, expiry and throttling`, { skip: backend === 'PHP' && !hasPHP }, async t => {
    const dir = mkdtempSync(path.join(process.cwd(), '.test-operator-'));
    const filename = path.join(dir, 'state.db');
    writeFileSync(path.join(dir, 'lem-time.json'), JSON.stringify(initial));
    let server = await serve(backend, filename);
    t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
    const a = client(server, 'a'.repeat(32)), b = client(server, 'b'.repeat(32));
    const firstRead = await a.get();
    assert.equal(firstRead.response.headers.get('set-cookie'), null, 'public reads must never replace browser credentials');
    let state = firstRead.body;
    assert.deepEqual(state.auth, { configured: true, authorized: false });
    assert.equal(state.settings.pin, '');
    assert.ok(!JSON.stringify(state).includes('2468'));
    assert.ok(!JSON.stringify(state).includes('pbkdf2'));
    const db = new DatabaseSync(filename);
    t.after(() => db.close());
    assert.match(db.prepare('SELECT pin FROM settings').get().pin, /^pbkdf2\$210000\$/);
    assert.equal((await a.request('PUT', state)).response.status, 401);
    assert.equal((await a.action('configure', '')).response.status, 401);
    const bootstrap = await a.action('bootstrap');
    assert.equal(bootstrap.response.status, 200);
    assert.equal(bootstrap.body.auth.authorized, false, 'cookie establishment must not grant authorization');
    assert.match(bootstrap.response.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(bootstrap.response.headers.get('set-cookie'), /SameSite=Strict/i);
    assert.equal((await a.action('unlock', '0000')).response.status, 401);
    const unlocked = await a.action('unlock', '2468');
    assert.equal(unlocked.response.status, 200);
    assert.equal(unlocked.response.headers.get('set-cookie'), null, 'existing cookies must not be overwritten by delayed responses');
    assert.deepEqual(unlocked.body.auth, { configured: true, authorized: true });
    assert.equal((await b.request('GET', undefined, {Cookie: ''})).response.headers.get('set-cookie'), null,
      'a delayed cookie-less reader must not overwrite a newly authorized browser cookie');
    assert.equal((await b.get()).body.auth.authorized, false);
    // Even when the browser sends another tab's HttpOnly cookie, this window needs its own session.
    assert.equal((await b.request('PUT', state, { Cookie: a.cookie() })).response.status, 401);
    // Reloads/new documents reuse one browser cookie, not one cookie per document.
    const browserCookie = a.cookie();
    for (let index = 0; index < 8; index++) {
      const reload = client(server, index.toString(16).padStart(32, '0'));
      const result = await reload.request('POST', {action: 'unlock', pin: '2468'}, {Cookie: browserCookie});
      assert.equal(result.response.status, 200);
      assert.equal(result.response.headers.get('set-cookie'), null);
    }
    assert.ok(browserCookie.length < 100);
    assert.equal((await a.get()).body.auth.authorized, true);
    assert.equal((await a.request('PUT', { ...state, settings: { pin: '9999' } })).response.status, 400);
    const saved = await a.request('PUT', { ...state, timerCommands: ['show'],
      shows: state.shows.map(show => ({ ...show, status: 'Paused' })) });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.shows[0].status, 'Paused');
    assert.equal((await b.request('PUT', saved.body)).response.status, 401);
    assert.equal((await b.action('unlock', '2468')).response.status, 200);
    assert.equal((await a.action('lock')).body.auth.authorized, false);
    assert.equal((await b.get()).body.auth.authorized, true);
    assert.equal((await a.request('PUT', saved.body)).response.status, 401);
    assert.equal((await a.action('unlock', '2468')).response.status, 200);
    const previousCookie = b.cookie();
    assert.equal((await b.action('configure', '135790')).response.status, 200);
    assert.notEqual(b.cookie(), previousCookie, 'PIN changes must rotate the browser credential too');
    assert.equal((await a.get()).body.auth.authorized, false, 'changing PIN must revoke other sessions');
    assert.equal((await b.get()).body.auth.authorized, true, 'configuring operator stays authorized');
    state = (await b.get()).body;
    for (const clockFormat of ['12h', '24h']) {
      const next = { ...state, timerCommands: [], shows: state.shows.map(show => ({
        ...show, cues: show.cues.map(cue => ({ ...cue, type: 'clock', duration: 0, clockFormat })),
      })) };
      const result = await b.request('PUT', next);
      assert.equal(result.response.status, 200);
      state = result.body;
      assert.equal(state.shows[0].cues[0].clockFormat, clockFormat);
    }
    const formatChange = structuredClone(state);
    formatChange.shows[0].cues[0].clockFormat = '12h';
    assert.deepEqual(timerCommands(state, formatChange), []);
    assert.equal((await b.request('PUT', { ...state, shows: state.shows.map(show => ({
      ...show, cues: show.cues.map(cue => ({ ...cue, clockFormat: 'invalid' })),
    })) })).response.status, 400);
    db.exec('UPDATE operator_sessions SET expires = 0');
    assert.equal((await b.request('PUT', state)).response.status, 401);
    assert.equal((await b.get()).body.auth.authorized, false);
    // Persisted counters survive worker/server restarts.
    db.exec('DELETE FROM operator_throttle');
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await a.action('unlock', '0000')).response.status, 401);
    assert.equal((await a.action('unlock', '135790')).response.status, 429);
    await server.close();
    server = await serve(backend, filename);
    const c = client(server, 'c'.repeat(32));
    assert.equal((await c.action('unlock', '135790')).response.status, 429);
    db.exec('UPDATE operator_throttle SET expires = 0');
    assert.equal((await c.action('unlock', '135790')).response.status, 200);
    assert.equal((await c.action('configure', '')).body.auth.configured, false);
    assert.equal((await client(server, 'd'.repeat(32)).request('PUT', state)).response.status, 200);
    // Upgrade existing plaintext SQLite too, with no raw PIN in any response.
    db.prepare('UPDATE settings SET pin = ?').run('7788');
    await server.close();
    server = await serve(backend, filename);
    const migrated = client(server, 'e'.repeat(32));
    assert.equal((await migrated.get()).body.settings.pin, '');
    assert.match(db.prepare('SELECT pin FROM settings').get().pin, /^pbkdf2\$/);
    assert.equal((await migrated.action('unlock', '7788')).response.status, 200);
  });
}
