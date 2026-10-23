import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStore } from './server.mjs';
import { isShow, isStatePayload } from './lib/schema.js';
import { mergeState, timerCommands } from './lib/sync.js';
import { brandingSnapshot } from './lib/branding.js';

const show = { id: 'messages', title: 'Messages', active: 'cue', left: 60, status: 'Running',
  cues: [{ id: 'cue', name: 'Timer', duration: 60 }], templateId: 'bayer-light', logoOn: false };
const legacy = { text: 'Stand by', destinations: { display: true, dsm: false } };
const legacyMessages = [
  { ...legacy, text: '' }, { ...legacy, text: ' \n\t\u00a0\ufeff' },
  { ...legacy, text: 'a'.repeat(501) },
  { ...legacy, destinations: { display: false, dsm: false } },
  { text: '', destinations: { display: false, dsm: false } },
];
const message = { text: '<img src=x onerror=alert(1)>\nStand by & wait',
  destinations: { display: true, dsm: true, chroma: true }, color: '#12aBcF', flash: true, bold: false, uppercase: true };
const invalid = [
  { ...message, text: '' }, { ...message, text: ' \n\t\u00a0\ufeff' }, { ...message, text: 'a'.repeat(501) },
  { ...message, destinations: { display: false, dsm: false, chroma: false } },
  ...['yes', 1, null].flatMap(value => [
    { ...message, flash: value }, { ...message, bold: value }, { ...message, uppercase: value },
    { ...legacy, bold: value }, { ...legacy, uppercase: value },
    { ...message, destinations: { ...message.destinations, chroma: value } },
    { ...message, destinations: { ...message.destinations, display: value } },
    { ...message, destinations: { ...message.destinations, dsm: value } },
  ]),
  ...['red', '#fff', '#123456\n', '#12345g', 'url(x)', null].map(color => ({ ...message, color })),
  ...legacyMessages.flatMap(old => [
    { ...old, color: '#ffffff' }, { ...old, flash: false }, { ...old, bold: false }, { ...old, uppercase: true },
    { ...old, destinations: { ...old.destinations, chroma: false } },
  ]),
  { ...legacy, color: 'red' }, { ...legacy, flash: 'false' },
  { ...legacy, destinations: { ...legacy.destinations, chroma: null } },
];
const state = message => ({ revision: 0, shows: [{ ...show, ...(message ? { message } : {}) }], settings: { pin: '' } });

test('message schema bounds plain text, strict colors and booleans while preserving legacy messages', () => {
  for (const valid of [legacy, ...legacyMessages, message, { ...legacy, bold: true }, { ...legacy, uppercase: false },
    { ...message, bold: true, uppercase: false }, { ...message, text: 'a'.repeat(500) },
    { ...message, text: '😀'.repeat(250) }, { ...legacy, destinations: { ...legacy.destinations, display: false, chroma: true } }]) {
    assert.equal(isShow({ ...show, message: valid }), true);
  }
  for (const bad of invalid) assert.equal(isShow({ ...show, message: bad }), false, JSON.stringify(bad));
  assert.equal('message' in brandingSnapshot({ ...show, message }), false);
});

test('legacy empty, long and unselected messages migrate, load, save unrelated edits and reload in Node', t => {
  const directory = mkdtempSync(path.join(process.cwd(), '.test-messages-legacy-'));
  const shows = legacyMessages.map((message, index) => ({ ...show, id: `legacy-${index}`, message }));
  writeFileSync(path.join(directory, 'lem-time.json'), JSON.stringify({
    initialized: true, revision: 7, shows, settings: { pin: '' },
  }));
  let store = createStore(path.join(directory, 'state.db'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const check = () => {
    const loaded = store.getState();
    assert.equal(isStatePayload(loaded), true);
    assert.deepEqual(loaded.shows.map(show => show.message), legacyMessages);
    return loaded;
  };
  assert.equal(check().revision, 7);
  store.close();
  store = createStore(path.join(directory, 'state.db'));
  const reloaded = check();
  store.saveState({ ...reloaded, shows: reloaded.shows.map(show => ({ ...show, title: 'Edited' })), timerCommands: [] });
  store.close();
  store = createStore(path.join(directory, 'state.db'));
  assert.equal(check().shows[0].title, 'Edited');
});

test('message merges are atomic, independent of timer controls and metadata', () => {
  const base = state(message);
  const local = state({ ...message, text: 'Local' });
  const remote = state({ ...message, color: '#ffffff' });
  assert.throws(() => mergeState(base, local, remote), /overlap/);
  remote.shows[0].message = message;
  remote.shows[0].left = 30;
  remote.shows[0].status = 'Paused';
  const merged = mergeState(base, local, remote);
  assert.deepEqual(merged.shows[0].message, local.shows[0].message);
  assert.equal(merged.shows[0].left, 30);
  assert.equal(merged.shows[0].status, 'Paused');
  assert.deepEqual(timerCommands(remote, merged), []);
  const cleared = state();
  assert.equal(mergeState(base, cleared, remote).shows[0].message, undefined);
  assert.throws(() => mergeState(base, cleared, local), /overlap/);
});

test('Node persists message send and clear without replacing the running timer', t => {
  const directory = mkdtempSync(path.join(process.cwd(), '.test-messages-node-'));
  let store = createStore(path.join(directory, 'state.db'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const initial = store.saveState(state(legacy));
  const sent = store.saveState({ ...initial, shows: [{ ...initial.shows[0], message }], timerCommands: [] });
  assert.deepEqual(sent.shows[0].message, message);
  assert.deepEqual(sent.timerVersions, initial.timerVersions);
  for (const bad of invalid) assert.throws(() =>
    store.saveState({ ...sent, shows: [{ ...sent.shows[0], message: bad }] }));
  store.close();
  store = createStore(path.join(directory, 'state.db'));
  assert.deepEqual(store.getState().shows[0].message, message);
  for (const formatted of [{ ...message, bold: true, uppercase: false }, { ...legacy, bold: false },
    { ...legacy, uppercase: true }]) {
    const current = store.getState();
    store.saveState({ ...current, shows: [{ ...current.shows[0], message: formatted }], timerCommands: [] });
    store.close();
    store = createStore(path.join(directory, 'state.db'));
    assert.deepEqual(store.getState().shows[0].message, formatted);
  }
  const cleared = store.saveState({ ...store.getState(), shows: [{ ...show }], timerCommands: [] });
  assert.equal(cleared.shows[0].message, undefined);
  assert.deepEqual(cleared.timerVersions, sent.timerVersions);
  store.close();
  store = createStore(path.join(directory, 'state.db'));
  assert.equal(store.getState().shows[0].message, undefined);
});

test('PHP validates and persists legacy and extended messages and clear without timer changes',
  { skip: spawnSync('php', ['-r', 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);']).status !== 0 }, async t => {
    const directory = mkdtempSync(path.join(process.cwd(), '.test-messages-php-'));
    writeFileSync(path.join(directory, 'lem-time.json'), JSON.stringify({
      initialized: true, revision: 7, settings: { pin: '' },
      shows: legacyMessages.map((message, index) => ({ ...show, id: `legacy-${index}`, message })),
    }));
    const child = spawn('php', ['-S', '127.0.0.1:0', '-t', new URL('./php/', import.meta.url).pathname], {
      env: { ...process.env, DB_PATH: path.join(directory, 'state.db'), STATE_PATH: '' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    t.after(async () => { child.kill(); await once(child, 'exit'); rmSync(directory, { recursive: true, force: true }); });
    const base = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('PHP startup timeout')), 5000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.stderr.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
    });
    const put = data => fetch(`${base}/api.php`, { method: 'PUT',
      headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const get = () => fetch(`${base}/api.php`).then(response => response.json());
    const migrated = await get();
    assert.equal(migrated.revision, 7);
    assert.equal(isStatePayload(migrated), true);
    assert.deepEqual(migrated.shows.map(show => show.message), legacyMessages);
    assert.equal((await put({ ...migrated, shows: migrated.shows.map(show => ({ ...show, title: 'Edited' })),
      timerCommands: [] })).status, 200);
    const reloaded = await get();
    assert.equal(isStatePayload(reloaded), true);
    assert.deepEqual(reloaded.shows.map(show => show.message), legacyMessages);
    assert.equal(reloaded.shows[0].title, 'Edited');
    let result = await (await put({ ...state(legacy), revision: reloaded.revision })).json();
    assert.deepEqual(result.shows[0].message, legacy);
    const versions = result.timerVersions;
    result = await (await put({ ...result, shows: [{ ...result.shows[0], message }], timerCommands: [] })).json();
    assert.deepEqual((await get()).shows[0].message, message);
    assert.deepEqual(result.timerVersions, versions);
    for (const bad of invalid) assert.equal((await put({ ...result, shows: [{ ...show, message: bad }] })).status, 400);
    for (const formatted of [{ ...message, bold: true, uppercase: false }, { ...legacy, bold: false },
      { ...legacy, uppercase: true }]) {
      result = await (await put({ ...result, shows: [{ ...result.shows[0], message: formatted }], timerCommands: [] })).json();
      assert.deepEqual((await get()).shows[0].message, formatted);
      assert.deepEqual(result.timerVersions, versions);
    }
    const clearedShow = { ...result.shows[0] };
    delete clearedShow.message;
    assert.equal((await put({ ...result, shows: [clearedShow], timerCommands: [] })).status, 200);
    assert.equal((await get()).shows[0].message, undefined);
    assert.deepEqual((await get()).timerVersions, versions);
  });
