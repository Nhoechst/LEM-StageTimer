import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createStore } from './server.mjs';
import { mergeState, serialize, timerCommands } from './lib/sync.js';
import { remainingSeconds } from './lib/remaining-time.js';

const state = () => ({
  shows: [{ id: 'one', title: 'Show', active: 'cue', left: 10, status: 'Running',
    cues: [{ id: 'cue', name: 'Cue', duration: 10 }], templateId: 'blue', logoOn: true }],
  settings: { pin: '' },
});
const change = (data, fields) => ({ ...data, shows: data.shows.map(show => ({ ...show, ...fields })) });

test('remaining time accepts only positive safe whole minutes and seconds', () => {
  assert.equal(remainingSeconds('2', '03'), 123);
  assert.equal(remainingSeconds('0', '1'), 1);
  assert.equal(remainingSeconds('150119987579016', '31'), Number.MAX_SAFE_INTEGER);
  for (const [minutes, seconds] of [
    ['', '1'], ['1', ''], ['-1', '0'], ['0', '-1'], ['1.5', '0'], ['0', '1.5'],
    ['NaN', '1'], ['Infinity', '0'], ['1e2', '0'], [' 1', '0'], ['0', '60'],
    ['0', '0'], ['9007199254740992', '0'], ['150119987579016', '32'],
    ['9'.repeat(400), '1'],
  ]) assert.equal(remainingSeconds(minutes, seconds), null, `${minutes}:${seconds}`);
});

test('explicit same-value restarts survive ticks and metadata rebases but reject genuine conflicts', () => {
  const base = state();
  const versions = { one: ['cue', 10, 'Running', 10000] };
  const progress = change(base, { left: 8, title: 'Remote title' });
  assert.deepEqual(timerCommands(base, base, ['one']), ['one']);
  const merged = mergeState(base, base, progress, versions, versions, ['one']);
  assert.equal(merged.shows[0].left, 10);
  assert.equal(merged.shows[0].title, 'Remote title');
  assert.deepEqual(merged.shows[0].cues, base.shows[0].cues);
  assert.throws(() => mergeState(base, base, progress, versions,
    { one: ['cue', 10, 'Running', 11000] }, ['one']), /Timer controls/);
  for (const remote of [
    { ...base, shows: [] },
    change(base, { active: 'other' }),
    change(base, { cues: [] }),
    change(base, { cues: [{ ...base.shows[0].cues[0], duration: 60 }] }),
    change(base, { cues: [{ ...base.shows[0].cues[0], name: 'Changed cue' }] }),
  ]) assert.throws(() => mergeState(base, base, remote, versions, versions, ['one']), /active cue/);
  assert.throws(() => mergeState(base, base, change(base, {cues: []}),
    undefined, undefined, ['one']), /active cue/);
});

test('same-value explicit remaining-time command replaces the Node deadline without changing cue duration', t => {
  const dir = mkdtempSync(path.join(process.cwd(), '.test-remaining-'));
  const store = createStore(path.join(dir, 'clock.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const first = store.saveState({ ...state(), revision: 0, timerCommands: ['one'] });
  now += 400;
  const restarted = store.saveState({ ...first, timerCommands: ['one'] });
  assert.equal(restarted.shows[0].left, 10);
  assert.equal(restarted.shows[0].status, 'Running');
  assert.equal(restarted.shows[0].cues[0].duration, 10);
  assert.equal(restarted.timerVersions.one[3], first.timerVersions.one[3] + 400);
  now += 1100;
  assert.equal(store.getState().shows[0].left, 9);
});

test('server field ordering and omitted undefined values never trigger autosaves', () => {
  const base = state();
  const merged = mergeState(base, base, base);
  assert.equal(serialize(merged), serialize(base));
  assert.equal(serialize({ a: 1, b: undefined }), serialize({ a: 1 }));
  assert.equal(serialize({ a: 1, b: 2 }), serialize({ b: 2, a: 1 }));
});

test('polling merges timer progress with local edits without making timer commands', () => {
  const base = state();
  const local = change(base, { title: 'Local title' });
  const remote = change(base, { left: 7 });
  const merged = mergeState(base, local, remote);
  assert.equal(merged.shows[0].title, 'Local title');
  assert.equal(merged.shows[0].left, 7);
  assert.deepEqual(timerCommands(remote, merged), []);
  assert.deepEqual(mergeState(base, base, remote), remote);
  assert.deepEqual(mergeState(base, local, change(remote, { logoOn: false })).shows[0],
    { ...local.shows[0], left: 7, logoOn: false });
});

test('only genuine overlapping edits conflict, including deletion versus editing', () => {
  const base = state();
  const local = change(base, { title: 'Local' });
  assert.throws(() => mergeState(base, local, change(base, { title: 'Remote' })), /overlap/);
  const deleted = { ...base, shows: [] };
  assert.throws(() => mergeState(base, local, deleted), /overlap/);
  assert.throws(() => mergeState(base, deleted, local), /overlap/);
  assert.throws(() => mergeState(base,
    change(base, { cues: [] }),
    change(base, { cues: [{ ...base.shows[0].cues[0], name: 'Renamed' }] })), /overlap/);
  assert.deepEqual(mergeState(base, base, deleted), deleted);
});

test('timer commands can rebase over ticks but not another real timer command', () => {
  const base = state();
  const local = change(base, { left: 20 });
  const remote = change(base, { left: 7 });
  const versions = { one: ['cue', 10, 'Running', 10000] };
  assert.equal(mergeState(base, local, remote, versions, versions).shows[0].left, 20);
  assert.throws(() => mergeState(base, local, remote, versions,
    { one: ['cue', 10, 'Running', 11000] }), /Timer controls/);
});

test('deletion rebases over elapsed time but conflicts with a real remote timer command', () => {
  const base = state();
  const deleted = { ...base, shows: [] };
  const remote = change(base, { left: 0, status: 'Complete' });
  const versions = { one: ['cue', 10, 'Running', 10000] };
  assert.deepEqual(mergeState(base, deleted, remote, versions, versions), deleted);
  assert.throws(() => mergeState(base, deleted, remote, versions,
    { one: ['cue', 10, 'Running', 11000] }), /overlap/);
});

test('one server clock across connections survives restart, reads, metadata saves and stale controllers', t => {
  const dir = mkdtempSync(path.join(process.cwd(), '.test-clock-'));
  const filename = path.join(dir, 'clock.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  let writer = createStore(filename);
  let reader = createStore(filename);
  t.after(() => { writer.close(); reader.close(); });
  writer.saveState({ ...state(), revision: 0, timerCommands: ['one'] });
  const initialVersion = writer.getState().timerVersions;
  now += 3100;
  for (let index = 0; index < 10; index++) {
    assert.equal(reader.getState().shows[0].left, 7);
    assert.equal(writer.getState().revision, 1);
  }
  const edited = writer.saveState({ ...change(state(), { title: 'Edited', left: 999 }),
    revision: 1, timerCommands: [] });
  assert.equal(edited.shows[0].left, 7);
  assert.deepEqual(edited.timerVersions, initialVersion);
  assert.equal(edited.shows[0].title, 'Edited');
  reader.close();
  reader = createStore(filename);
  now += 1000;
  assert.equal(reader.getState().shows[0].left, 6);
  const controllerA = reader.getState();
  const controllerB = writer.getState();
  writer.saveState({ ...change(controllerA, { left: 20 }), timerCommands: ['one'] });
  assert.throws(() => reader.saveState({ ...change(controllerB, { status: 'Paused' }),
    timerCommands: ['one'] }), error => error.status === 409);
  const accepted = reader.getState();
  assert.equal(accepted.shows[0].left, 20);
  now += 25000;
  assert.equal(reader.getState().shows[0].left, 0);
  assert.equal(reader.getState().shows[0].status, 'Complete');
  assert.equal(reader.getState().revision, accepted.revision);
  assert.deepEqual(reader.getState().timerVersions, accepted.timerVersions);
});
