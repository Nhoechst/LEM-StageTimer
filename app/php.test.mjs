import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { assertState } from './state-test-helpers.mjs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const hasPHP = spawnSync('php', ['-r', 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);']).status === 0;
const api = new URL('./php/api.php', import.meta.url).pathname;
const publicRoot = new URL('./php/', import.meta.url).pathname;

async function startServer(statePath) {
  const child = spawn('php', ['-S', '127.0.0.1:0', '-t', publicRoot], {
    env: { ...process.env, DB_PATH: statePath, STATE_PATH: '' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    const base = await new Promise((resolve, reject) => {
      let log = '';
      const timer = setTimeout(() => reject(new Error('PHP startup timed out: ' + log)), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`PHP exited ${code}: ${log}`)); });
      child.stderr.on('data', chunk => {
        log += chunk;
        const match = log.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    return { child, base };
  } catch (error) {
    child.kill();
    throw error;
  }
}

test('PHP shares a persistent server clock across workers without read revisions or timer reset on metadata saves',
  { skip: !hasPHP }, async t => {
    const dir = mkdtempSync(path.join(process.cwd(), '.test-php-clock-'));
    const filename = path.join(dir, 'state.db');
    const a = await startServer(filename);
    const b = await startServer(filename);
    t.after(async () => {
      for (const server of [a, b]) {
        server.child.kill();
        await once(server.child, 'exit');
      }
      rmSync(dir, { recursive: true, force: true });
    });
    const get = server => fetch(`${server.base}/api.php`).then(response => response.json());
    const put = (server, data) => fetch(`${server.base}/api.php`, {
      method: 'PUT', headers: { Origin: server.base, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const initial = {
      shows: [{ id: 'clock', title: 'Timer', active: 'cue', left: 30, status: 'Running',
        cues: [{ id: 'cue', name: 'Cue', duration: 30 }], templateId: 'blue', logoOn: true }],
      settings: { pin: '' }, revision: 0, timerCommands: ['clock'],
    };
    assertState(await get(a), { initialized: false, revision: 0 });
    assertState(await get(b), { initialized: false, revision: 0 });
    const assertReaderDuringWrite = async expected => {
      const writer = new DatabaseSync(filename);
      writer.exec('BEGIN IMMEDIATE');
      try {
        const response = await fetch(`${b.base}/api.php`, { signal: AbortSignal.timeout(1500) });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).revision, expected);
      } finally {
        writer.exec('ROLLBACK');
        writer.close();
      }
    };
    await assertReaderDuringWrite(0);
    assert.equal((await put(a, initial)).status, 200);
    await assertReaderDuringWrite(1);
    const db = new DatabaseSync(filename);
    // Upgrade an established pre-clock database, then ensure reads stop taking write locks.
    db.exec('DROP TABLE timer_clock');
    const migrated = await Promise.all([get(a), get(b)]);
    assert.deepEqual(migrated[0].timerVersions, migrated[1].timerVersions);
    await assertReaderDuringWrite(1);
    db.prepare('UPDATE timer_clock SET deadline = ?').run(Date.now() + 15000);
    db.close();
    const first = await get(a);
    const second = await get(b);
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 1);
    assert.ok(second.shows[0].left <= 15 && second.shows[0].left >= 14);
    assert.deepEqual(first.timerVersions, second.timerVersions);
    const edit = { ...initial, revision: 1, timerCommands: [],
      shows: [{ ...initial.shows[0], title: 'Edited', left: 999 }] };
    const edited = await (await put(b, edit)).json();
    assert.equal(edited.shows[0].title, 'Edited');
    assert.ok(edited.shows[0].left <= 15);
    assert.deepEqual(edited.timerVersions, first.timerVersions);
    const races = await Promise.all([put(a, { ...initial, revision: 2 }),
      put(b, { ...initial, revision: 2 })]);
    assert.deepEqual(races.map(response => response.status).sort(), [200, 409]);
    const beforeCompletion = await get(a);
    await new Promise(resolve => setTimeout(resolve, 30));
    const restarted = await (await put(b, { ...beforeCompletion, timerCommands: ['clock'] })).json();
    assert.equal(restarted.shows[0].left, beforeCompletion.shows[0].left);
    assert.equal(restarted.shows[0].status, 'Running');
    assert.ok(restarted.timerVersions.clock[3] > beforeCompletion.timerVersions.clock[3],
      'same-value explicit command must replace the persisted deadline');
    assert.equal(restarted.shows[0].cues[0].duration, 30);
    const expire = new DatabaseSync(filename);
    expire.prepare('UPDATE timer_clock SET deadline = ?').run(Date.now() - 1000);
    expire.close();
    const complete = await get(b);
    assert.equal(complete.revision, restarted.revision);
    assert.equal(complete.shows[0].left, 0);
    assert.equal(complete.shows[0].status, 'Complete');
  });

test('PHP API persists state, backs up, rejects stale/invalid/cross-origin writes and protects storage',
  { skip: !hasPHP }, async t => {
    const dir = mkdtempSync(path.join(process.cwd(), '.test-php-'));
    const statePath = path.join(dir, 'private', 'lem-time.db');
    const readRevision = filename => {
      const db = new DatabaseSync(filename, { readOnly: true });
      try { return db.prepare('SELECT revision FROM meta').get().revision; }
      finally { db.close(); }
    };
    let child;
    let peer;
    t.after(async () => {
      if (peer && peer.exitCode === null) {
        peer.kill();
        await once(peer, 'exit');
      }
      if (child && child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
      rmSync(dir, { recursive: true, force: true });
    });
    // PHP chooses an available port and reports it on stderr.
    const server = await startServer(statePath);
    child = server.child;
    const base = server.base;
    const url = `${base}/api.php`;
    const put = (data, origin = base, target = url) => fetch(target, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(data),
    });
    assertState(await (await fetch(url)).json(), { initialized: false, revision: 0 });
    const show = {
      id: 'one', title: 'Test', cues: [{ id: 'cue', name: 'Cue', duration: 10 }],
      left: 10, status: 'Ready', templateId: 'blue', logoOn: true,
      message: { text: 'Stand by', destinations: { display: true, dsm: false } },
    };
    const state = { revision: 0, shows: [show], settings: { pin: '' } };
    const saved = { ...state, initialized: true, revision: 1 };
    assertState(await (await put(state)).json(), saved);
    assertState(await (await fetch(url)).json(), saved);
    assert.equal((await put(state)).status, 409);
    assert.equal((await put({ ...state, revision: 1 }, 'https://attacker.invalid')).status, 403);
    assert.equal((await put({ ...state, revision: 1 }, null)).status, 403);
    for (const invalid of [
      { ...state, shows: [show, show] },
      { ...state, shows: [{ ...show, cues: [show.cues[0], show.cues[0]] }] },
      { ...state, shows: [{ ...show, left: -1 }] },
      { ...state, shows: [{ ...show, message: null }] },
      { ...state, settings: { pin: 'bad' } },
      { ...state, revision: 1.5 },
    ]) assert.equal((await put(invalid)).status, 400);
    assert.equal((await fetch(url, {
      method: 'PUT', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{',
    })).status, 400);
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(url, {
      method: 'PUT', headers: { Origin: base, 'Content-Type': 'text/plain' }, body: '{}',
    })).status, 415);
    assert.equal((await put({ ...state, revision: 1, shows: [], padding: 'x'.repeat(10 * 1024 * 1024) })).status, 413);
    assert.equal((await put({ ...state, revision: 1, shows: [] })).status, 200);
    assert.equal(readRevision(`${statePath}.bak`), 1);
    mkdirSync(`${statePath}.bak-next`);
    writeFileSync(path.join(`${statePath}.bak-next`, 'blocked'), 'backup failure');
    assert.equal((await put({ ...state, revision: 2 })).status, 500);
    assertState(await (await fetch(url)).json(), {
      initialized: true, revision: 2, shows: [], settings: { pin: '1234' },
    });
    assert.equal(readRevision(statePath), 2);
    rmSync(`${statePath}.bak-next`, { recursive: true });
    const second = await startServer(statePath);
    peer = second.child;
    const races = await Promise.all([
      put({ ...state, revision: 2 }),
      put({ ...state, revision: 2 }, second.base, `${second.base}/api.php`),
    ]);
    assert.deepEqual(races.map(response => response.status).sort(), [200, 409]);
    assert.equal(readRevision(statePath), 3);
    const broken = new DatabaseSync(statePath);
    broken.exec("CREATE TRIGGER fail_save BEFORE INSERT ON shows BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    assert.equal((await put({ ...state, revision: 3 })).status, 500);
    assert.equal((await (await fetch(url)).json()).revision, 3);
    broken.exec('DROP TRIGGER fail_save');
    broken.close();
    // A new PHP process reads the same SQLite state after a restart.
    child.kill();
    await once(child, 'exit');
    child = spawn('php', ['-r',
      '$_SERVER["REQUEST_METHOD"]="GET"; $_SERVER["DOCUMENT_ROOT"]=$argv[1]; require $argv[2];',
      publicRoot, api,
    ], { env: { ...process.env, DB_PATH: statePath, STATE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    assert.deepEqual(await once(child, 'exit'), [0, null]);
    assert.equal(JSON.parse(output).revision, 3);
  });

test('PHP cue modes retain private JSON migration, count-up origins, pause/resume and cross-worker conflicts',
  {skip: !hasPHP}, async t => {
    const dir = mkdtempSync(path.join(process.cwd(), '.test-php-modes-'));
    const filename = path.join(dir, 'modes.db');
    const jsonPath = path.join(dir, 'lem-time.json');
    const show = (id, type, left = 0, status = 'Ready') => ({
      id, title: id, active: 'cue', left, status, templateId: 'blue', logoOn: true,
      cues: [{id: 'cue', name: 'Cue', duration: 0, ...(type === undefined ? {} : {type})}],
    });
    const source = JSON.stringify({initialized: true, revision: 7, settings: {pin: '1234'},
      shows: [show('up', 'countup', 65, 'Running'), show('wall', 'clock'), show('legacy')]});
    writeFileSync(jsonPath, source);
    const servers = [await startServer(filename), await startServer(filename)];
    t.after(async () => {
      for (const server of servers) {
        server.child.kill();
        await once(server.child, 'exit');
      }
      rmSync(dir, {recursive: true, force: true});
    });
    const get = () => fetch(`${servers[1].base}/api.php`).then(response => response.json());
    let cookie = '';
    const operator = 'abcdef0123456789abcdef0123456789';
    const put = data => fetch(`${servers[0].base}/api.php`, {
      method: 'PUT', headers: {Origin: servers[0].base, 'Content-Type': 'application/json', 'X-Operator-ID': operator, Cookie: cookie},
      body: JSON.stringify(data),
    });
    const imported = await get();
    const unlock = await fetch(`${servers[0].base}/api.php`, {
      method: 'POST', headers: {Origin: servers[0].base, 'Content-Type': 'application/json', 'X-Operator-ID': operator},
      body: JSON.stringify({action: 'unlock', pin: '1234'}),
    });
    assert.equal(unlock.status, 200);
    cookie = unlock.headers.get('set-cookie').split(';')[0];
    assert.equal(imported.revision, 7);
    assert.equal(readFileSync(jsonPath, 'utf8'), source);
    assert.equal(Object.hasOwn(imported.shows[2].cues[0], 'type'), false);
    assert.equal(imported.shows[0].left, 65);
    const db = new DatabaseSync(filename);
    db.prepare('UPDATE timer_clock SET deadline = ? WHERE show_id = ?').run(Date.now() - 69000, 'up');
    const progressed = await get();
    assert.ok(progressed.shows[0].left >= 69 && progressed.shows[0].left <= 70);
    assert.equal(progressed.shows[0].status, 'Running');
    assert.equal(progressed.shows[1].left, 0);
    for (let index = 0; index < 5; index++) assert.equal((await get()).revision, 7);
    const metadata = {...progressed, timerCommands: [],
      shows: progressed.shows.map(s => ({...s, title: 'Metadata', left: 999}))};
    const edited = await (await put(metadata)).json();
    assert.deepEqual(edited.timerVersions, progressed.timerVersions);
    assert.ok(edited.shows[0].left < 999);
    assert.equal(edited.shows[1].left, 0);
    const pause = {...edited, timerCommands: ['up'],
      shows: edited.shows.map(s => s.id === 'up' ? {...s, status: 'Paused'} : s)};
    const paused = await (await put(pause)).json();
    assert.equal(paused.shows[0].status, 'Paused');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM timer_clock').get().n, 0);
    const pausedLeft = paused.shows[0].left;
    assert.equal((await get()).shows[0].left, pausedLeft);
    const resume = {...paused, timerCommands: ['up'],
      shows: paused.shows.map(s => s.id === 'up' ? {...s, status: 'Running'} : s)};
    assert.equal((await put(resume)).status, 200);
    assert.equal((await put(resume)).status, 409);
    assert.ok(Math.abs(db.prepare('SELECT deadline FROM timer_clock').get().deadline -
      (Date.now() - pausedLeft * 1000)) < 2000);
    // A fresh PHP process and another worker must share the persisted origin.
    servers[1].child.kill();
    await once(servers[1].child, 'exit');
    servers[1] = await startServer(filename);
    assert.ok((await get()).shows[0].left >= pausedLeft);
    let current = await get();
    for (const type of [null, 'invalid', 1, {}]) {
      const invalid = {...current, shows: current.shows.map(s =>
        s.id === 'up' ? {...s, cues: [{...s.cues[0], type}]} : s)};
      assert.equal((await put(invalid)).status, 400);
    }
    const reset = {...current, timerCommands: ['up'], shows: current.shows.map(s =>
      s.id === 'up' ? {...s, left: 0, status: 'Ready'} : s)};
    current = await (await put(reset)).json();
    assert.equal(current.shows[0].left, 0);
    assert.equal(current.shows[0].status, 'Ready');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM timer_clock').get().n, 0);
    db.close();
    writeFileSync(jsonPath, '{changed after import');
    assert.equal((await get()).revision, current.revision);
  });

test('PHP without pdo_sqlite returns a controlled error', {
  skip: spawnSync('php', ['-n', '-v']).status !== 0,
}, () => {
  const result = spawnSync('php', ['-n', '-r',
    '$_SERVER["REQUEST_METHOD"]="GET"; require $argv[1];', api,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).error, /pdo_sqlite/);
  assert.match(result.stderr, /Enable pdo_sqlite/);
});

test('SQLite imports JSON once, preserves revisions and files, and rejects unsafe or corrupt storage',
  { skip: !hasPHP }, t => {
    const dir = mkdtempSync(path.join(process.cwd(), '.test-json-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const statePath = path.join(dir, 'lem-time.db');
    const jsonPath = path.join(dir, 'lem-time.json');
    const read = (filename = statePath, root = publicRoot, extra = {}) => {
      const result = spawnSync('php', ['-r',
        '$_SERVER["REQUEST_METHOD"]="GET"; $_SERVER["DOCUMENT_ROOT"]=$argv[1]; require $argv[2];',
        root, api,
      ], { env: { ...process.env, DB_PATH: filename, STATE_PATH: '', ...extra }, encoding: 'utf8' });
      assert.equal(result.status, 0);
      return JSON.parse(result.stdout);
    };
    assertState(read(), { initialized: false, revision: 0 });
    writeFileSync(jsonPath, '{invalid');
    assert.match(read().error, /Unable to access/);
    assert.equal(readFileSync(jsonPath, 'utf8'), '{invalid');
    writeFileSync(jsonPath, JSON.stringify({ initialized: true, revision: 1, shows: [] }));
    assert.match(read().error, /Unable to access/);
    const imported = {
      initialized: true, revision: 7, shows: [{
        id: 'imported', title: 'From JSON', cues: [
          { id: 'second', name: 'Second cue', duration: 2 },
          { id: 'first', name: 'First cue', duration: 1 },
        ], left: 2, status: 'Paused', templateId: 'blue', logoOn: true,
      }], settings: { pin: '1234' },
    };
    const source = JSON.stringify(imported);
    writeFileSync(jsonPath, source);
    assertState(read(), imported);
    assert.equal(readFileSync(jsonPath, 'utf8'), source);
    writeFileSync(jsonPath, '{changed after import');
    assertState(read(), imported);
    rmSync(jsonPath);
    rmSync(statePath);
    assert.match(read().error, /Unable to access/);
    rmSync(`${statePath}.bak`);
    writeFileSync(statePath, 'invalid SQLite');
    assert.match(read().error, /Unable to access/);
    assert.equal(readFileSync(statePath, 'utf8'), 'invalid SQLite');
    rmSync(statePath);
    writeFileSync(`${jsonPath}.bak`, source);
    assert.match(read().error, /Unable to access/);
    rmSync(`${jsonPath}.bak`);
    assert.match(read(statePath, dir).error, /Unable to access/);
    assert.match(read('relative.db').error, /Unable to access/);
    assert.match(read(jsonPath).error, /Unable to access/);
    const target = path.join(dir, 'untouched.db');
    writeFileSync(target, 'untouched');
    rmSync(statePath);
    symlinkSync(target, statePath);
    assert.match(read().error, /Unable to access/);
    rmSync(statePath);
    symlinkSync(target, jsonPath);
    assert.match(read().error, /Unable to access/);
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
  });
