import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { assertState } from './state-test-helpers.mjs';
import path from 'node:path';
import { createStore, createServer } from './server.mjs';
import { isShow, isStatePayload } from './lib/schema.js';

const show = () => ({
  id: 'show-1', title: 'Production', cues: [
    { id: 'cue-2', name: 'Second', duration: 10 },
    { id: 'cue-1', name: 'First', duration: 0 },
  ],
  active: 'cue-2', left: 9, status: 'Running', templateId: 'bayer-blue',
  logoOn: true, blackout: false, pinnedAt: 123, uploadedLogo: '', logoName: '',
  uploadedLogoLight: 'data:image/png;base64,AA==', logoNameLight: 'logo.png',
  uploadedLogoDark: '', logoNameDark: '',
  message: { text: 'Stand by', destinations: { display: true, dsm: false } },
});
const payload = (revision = 0, shows = [show()]) => ({ revision, shows, settings: { pin: '' } });

function fixture(t) {
  const dir = mkdtempSync(path.join(process.cwd(), '.test-backend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath: path.join(dir, 'lem-time.db') };
}

test('shared schema validates every nested field and unique IDs', () => {
  assert.equal(isShow(show()), true);
  assert.equal(isStatePayload(payload()), true);
  assert.equal(isStatePayload({ ...payload(), shows: [] }), true);
  assert.equal(isStatePayload({ ...payload(), settings: { pin: '' } }), true);
  for (const bad of [
    null, [], {}, { ...payload(), revision: -1 }, { ...payload(), revision: 0.1 },
    { ...payload(), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...payload(), settings: { pin: 1234 } }, { ...payload(), settings: { pin: '12ab' } },
    { ...payload(), settings: { pin: '1234567' } },
    { ...payload(), shows: [show(), show()] },
  ]) assert.equal(isStatePayload(bad), false);
  for (const bad of [
    { ...show(), id: ' ' }, { ...show(), title: null }, { ...show(), status: 'invalid' },
    { ...show(), left: Infinity }, { ...show(), left: -1 }, { ...show(), logoOn: 'true' },
    { ...show(), blackout: 0 }, { ...show(), pinnedAt: -1 }, { ...show(), active: null },
    { ...show(), uploadedLogo: 4 }, { ...show(), logoName: false },
    { ...show(), cues: [show().cues[0], show().cues[0]] },
    { ...show(), cues: [{ id: '', name: 'cue', duration: 1 }] },
    { ...show(), cues: [{ id: 'x', name: 3, duration: 1 }] },
    { ...show(), cues: [{ id: 'x', name: 'cue', duration: -1 }] },
    { ...show(), message: { text: 'x', destinations: { display: true } } },
    { ...show(), message: { text: 0, destinations: { display: true, dsm: false } } },
  ]) assert.equal(isShow(bad), false);
});

test('SQLite persists ordered shows/cues, empty initialized state and rolling backups', t => {
  const { dbPath } = fixture(t);
  let store = createStore(dbPath);
  assert.deepEqual(store.getState(), { initialized: false, revision: 0 });
  const second = { ...show(), id: 'show-2', cues: [{ id: 'cue-2', name: 'Shared ID', duration: 2 }] };
  const first = payload(0, [second, show()]);
  assertState(store.saveState(first), { initialized: true, ...first, revision: 1 });
  let backup = createStore(`${dbPath}.bak`);
  assert.deepEqual(backup.getState(), { initialized: false, revision: 0 });
  backup.close();
  assertState(store.saveState(payload(1, [])), {
    initialized: true, revision: 2, shows: [], settings: { pin: '1234' },
  });
  backup = createStore(`${dbPath}.bak`);
  assertState(backup.getState(), { initialized: true, ...first, revision: 1 });
  backup.close();
  store.close();
  store = createStore(dbPath);
  assert.deepEqual(store.getState().shows, []);
  assert.equal(store.getState().initialized, true);
  assert.equal(store.getState().revision, 2);
  store.close();
  assert.equal(existsSync(`${dbPath}.bak-next`), false);
});

test('stale revisions, failed backups and failed SQL writes preserve committed state', t => {
  const { dir, dbPath } = fixture(t);
  const store = createStore(dbPath);
  t.after(() => store.close());
  store.saveState(payload());
  assert.throws(() => store.saveState(payload()), error => error.status === 409 && error.extra.revision === 1);
  mkdirSync(`${dbPath}.bak-next`);
  writeFileSync(path.join(`${dbPath}.bak-next`, 'block'), 'backup cannot be replaced');
  assert.throws(() => store.saveState(payload(1, [])));
  assert.equal(store.getState().revision, 1);
  rmSync(`${dbPath}.bak-next`, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON shows BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  db.close();
  assert.throws(() => store.saveState(payload(1)));
  assertState(store.getState(), { initialized: true, ...payload(), revision: 1 });
  assert.equal(existsSync(path.join(dir, 'lem-time.db.bak')), true);
});

async function start(t, options = {}) {
  const f = fixture(t);
  const distDir = path.join(f.dir, 'dist');
  mkdirSync(distDir);
  writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><p>LEM-Time</p>');
  writeFileSync(path.join(distDir, 'app.js'), 'console.log("app")');
  writeFileSync(path.join(distDir, 'secret.db'), 'not public');
  writeFileSync(path.join(f.dir, 'outside.js'), 'not public');
  symlinkSync(path.join(f.dir, 'outside.js'), path.join(distDir, 'link.js'));
  symlinkSync(f.dir, path.join(distDir, 'linked-dir'));
  const server = createServer({ dbPath: f.dbPath, distDir, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { ...f, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP state contract, concurrent revisions, CORS and graceful validation errors', async t => {
  const { base, dbPath } = await start(t);
  assertState(await (await fetch(`${base}/api/state`)).json(), { initialized: false, revision: 0 });
  const put = (body, headers = {}) => fetch(`${base}/api/state`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  assert.equal((await put(payload(), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await put(payload(), { Origin: 'http://localhost:9999' })).status, 403);
  assert.equal((await put(payload(), { Origin: 'null' })).status, 403);
  assert.equal((await put(payload(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await put('{')).status, 400);
  assert.equal((await put({ ...payload(), settings: { pin: 'abc' } })).status, 400);
  const preflight = await fetch(`${base}/api/state`, {
    method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const results = await Promise.all([put(payload()), put(payload())]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const saved = await (await fetch(`${base}/api/state`, { headers: { Origin: base } })).json();
  assertState(saved, { initialized: true, ...payload(), revision: 1 });
  const empty = await put(payload(1, []), { Origin: 'http://localhost:4173' });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).initialized, true);
  assert.equal((await fetch(`${base}/api/state`, { method: 'DELETE' })).status, 405);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/state`, { headers: { Host: 'attacker.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  mkdirSync(`${dbPath}.bak-next`);
  writeFileSync(path.join(`${dbPath}.bak-next`, 'block'), 'keep backup unavailable');
  const failed = await put(payload(2));
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'Unable to complete request.' });
  assert.equal((await (await fetch(`${base}/api/state`)).json()).revision, 2);
});

test('HTTP limits JSON bodies including chunked transfers', async t => {
  const { base } = await start(t);
  const response = await fetch(`${base}/api/state`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(10 * 1024 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(' '.repeat(6 * 1024 * 1024));
    req.end(' '.repeat(5 * 1024 * 1024));
  });
  assert.equal(status, 413);
});

test('APP_ORIGIN rejects noncanonical origins before opening the database', () => {
  let storeTouched = false;
  const store = new Proxy({}, { get() { storeTouched = true; throw new Error('Store accessed'); } });
  for (const appOrigin of [
    '', null, 'timers.example', 'ftp://timers.example', 'https://timers.example/',
    'https://timers.example/path', 'https://timers.example?x=1', 'https://timers.example#x',
    '******timers.example', 'https://TIMERS.example', 'https://timers.example:443',
    'https://timers.example,http://localhost:5173',
  ]) {
    assert.throws(() => createServer({ appOrigin, store }), /APP_ORIGIN/, String(appOrigin));
  }
  assert.equal(storeTouched, false);
});

test('configured TLS origin accepts public or loopback proxy Host without allowing arbitrary origins', async t => {
  const appOrigin = 'https://timers.example:8443';
  const { base } = await start(t, { appOrigin });
  const request = (host, origin, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/state`, {
      method, headers: {
        Host: host, ...(origin === undefined ? {} : { Origin: origin }),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null });
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  for (const host of ['timers.example:8443', '127.0.0.1:3001', 'localhost:3001']) {
    const response = await request(host, appOrigin);
    assert.equal(response.status, 200, host);
    assert.equal(response.headers['access-control-allow-origin'], appOrigin);
  }
  assert.equal((await request('timers.example:8443')).status, 200);
  assert.equal((await request('127.0.0.1:3001', appOrigin, 'OPTIONS')).status, 204);
  const saved = await request('timers.example:8443', appOrigin, 'PUT', payload());
  assert.equal(saved.status, 200);
  assert.equal(isStatePayload(saved.body), true);
  assertState(saved.body, { initialized: true, ...payload(), revision: 1 });
  for (const [host, origin] of [
    ['attacker.example', appOrigin], ['timers.example:443', appOrigin],
    ['timers.example:8443', 'http://timers.example:8443'],
    ['127.0.0.1:3001', 'https://timers.example'],
    ['127.0.0.1:3001', 'https://attacker.example:8443'],
    ['timers.example:8443', 'https://timers.example.attacker.example:8443'],
    ['timers.example:8443', 'null'],
  ]) assert.equal((await request(host, origin)).status, 403, `${host} ${origin}`);
  assert.equal((await request('127.0.0.1:3001', 'http://localhost:5173')).status, 200);
});

test('static serving permits built assets and SPA routes but not API fallback, traversal or symlinks', async t => {
  const { base } = await start(t);
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${base}/control/show-1`, { headers: { Accept: 'text/html' } })).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${base}/app.js`, { method: 'HEAD' })).status, 200);
  for (const url of [
    '/api/nope', '/api', '/%61pi/nope', '/missing.js', '/secret.db', '/lem-time.db.bak',
    '/server.mjs', '/.git/config', '/link.js', '/linked-dir/outside.js',
    '/%2e%2e%2foutside.js', '/%5coutside.js',
  ]) {
    const response = await fetch(`${base}${url}`, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 404, url);
    assert.match(response.headers.get('content-type'), /application\/json/);
  }
  assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
});

test('actual server process survives restart with complete state, Vite proxy origins and backup recovery', async t => {
  const { dbPath } = fixture(t);
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'exit');
    child.kill('SIGTERM');
    await closed;
  };
  t.after(stop);
  const launch = async () => {
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: process.cwd(), env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Backend did not become ready.')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Backend exited before readiness.')); });
      let output = '';
      child.stdout.on('data', data => {
        output += data;
        const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.stderr.resume();
    });
  };
  const proxyRequest = (base, origin, body) => new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/state`, {
      method: body ? 'PUT' : 'GET',
      headers: {
        Host: '127.0.0.1:3001', Origin: origin,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  let base = await launch();
  assertState((await proxyRequest(base, 'http://localhost:5173')).body, {
    initialized: false, revision: 0,
  });
  const first = await proxyRequest(base, 'http://localhost:5173', payload());
  assert.equal(first.status, 200);
  assert.equal(isStatePayload(first.body), true);
  assertState(first.body, { initialized: true, ...payload(), revision: 1 });
  await stop();
  base = await launch();
  const restored = await proxyRequest(base, 'http://127.0.0.1:5173');
  assert.equal(restored.status, 200);
  assert.equal(isStatePayload(restored.body), true);
  assert.deepEqual(restored.body, first.body);
  const empty = await proxyRequest(base, 'http://127.0.0.1:5173', payload(1, []));
  assert.equal(empty.status, 200);
  assert.equal(isStatePayload(empty.body), true);
  assertState(empty.body, { initialized: true, ...payload(2, []), revision: 2 });
  const backup = new DatabaseSync(`${dbPath}.bak`, { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT revision FROM meta').get().revision, 1);
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM shows').get().count, 1);
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM cues').get().count, 2);
  } finally { backup.close(); }
  mkdirSync(`${dbPath}.bak-next`);
  writeFileSync(path.join(`${dbPath}.bak-next`, 'block'), 'backup failure');
  const failure = await proxyRequest(base, 'http://localhost:5173', payload(2));
  assert.equal(failure.status, 500);
  assert.deepEqual(failure.body, { error: 'Unable to complete request.' });
  await stop();
  base = await launch();
  assert.deepEqual((await proxyRequest(base, 'http://localhost:5173')).body, empty.body);
  for (const file of ['/lem-time.db', '/lem-time.db.bak', '/server.mjs', '/lib/schema.js', '/data.ts']) {
    assert.equal((await fetch(`${base}${file}`)).status, 404, file);
  }
});
