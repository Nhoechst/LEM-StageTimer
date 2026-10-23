import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createStore } from './server.mjs';
import { isStatePayload } from './lib/schema.js';
import { clockAnchor, cueType, formatTimer, projectTimer } from './lib/timer.js';
import { mergeState, timerCommands } from './lib/sync.js';

const state = type => ({
  revision: 0, settings: {pin: ''},
  shows: [{id: 'mode', title: 'Modes', active: 'cue', left: 0, status: 'Ready',
    cues: [{id: 'cue', name: 'Mode cue', duration: 0, ...(type === undefined ? {} : {type})}],
    templateId: 'bayer-blue', logoOn: true}],
});
const change = (data, fields) => ({...data, shows: [{...data.shows[0], ...fields}]});

test('cue types validate strictly, legacy countdowns remain unmodified, and formats agree', () => {
  for (const type of [undefined, 'countdown', 'countup', 'clock']) assert.ok(isStatePayload(state(type)));
  for (const type of [null, '', 'Count-up', 'standard', 1, {}, []]) assert.equal(isStatePayload(state(type)), false);
  const legacy = state().shows[0];
  assert.equal(cueType(legacy), 'countdown');
  assert.equal(Object.hasOwn(legacy.cues[0], 'type'), false);
  for (const type of ['countdown', 'countup']) {
    const show = {...state(type).shows[0], left: 3661};
    assert.equal(formatTimer(show), '1:01:01');
    show.left = 61;
    assert.equal(formatTimer(show), '1:01');
  }
  assert.equal(formatTimer(state('clock').shows[0], new Date(2026, 0, 1, 9, 2, 3)), '09:02:03');
  const twelve = state('clock').shows[0];
  twelve.cues[0].clockFormat = '12h';
  for (const [hour, expected] of [[0, '12:02:03 AM'], [9, '09:02:03 AM'], [12, '12:02:03 PM'], [23, '11:02:03 PM']]) {
    assert.equal(formatTimer(twelve, new Date(2026, 0, 1, hour, 2, 3)), expected);
  }
  for (const clockFormat of ['12h', '24h']) {
    assert.ok(isStatePayload(change(state('clock'), {cues: [{...twelve.cues[0], clockFormat}]})));
  }
  for (const clockFormat of [null, '12', '24', 12, {}]) {
    assert.equal(isStatePayload(change(state('clock'), {cues: [{...twelve.cues[0], clockFormat}]})), false);
  }
  const clock = {...state('clock').shows[0], status: 'Running'};
  projectTimer(clock, 0, 999999);
  assert.equal(clock.left, 0);
  assert.equal(clock.status, 'Running');
});

test('count-up server origin persists across windows/restarts, pause/resume/reset and metadata writes', t => {
  const dir = mkdtempSync(path.join(process.cwd(), '.test-modes-'));
  const filename = path.join(dir, 'modes.db');
  let writer = createStore(filename), reader = createStore(filename);
  t.after(() => { writer.close(); reader.close(); rmSync(dir, {recursive: true, force: true}); });
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  let saved = writer.saveState({...change(state('countup'), {left: 65, status: 'Running'}), timerCommands: ['mode']});
  assert.equal(saved.timerVersions.mode[3], 35000);
  const version = saved.timerVersions;
  now += 3100;
  for (let i = 0; i < 5; i++) {
    const observed = reader.getState();
    assert.equal(observed.shows[0].left, 68);
    assert.equal(observed.shows[0].status, 'Running');
    assert.equal(observed.revision, 1);
    assert.deepEqual(observed.timerVersions, version);
  }
  saved = writer.saveState({...change(reader.getState(), {title: 'Metadata', left: 9999,
    cues: [{...state('countup').shows[0].cues[0], name: 'Renamed'}]}), timerCommands: []});
  assert.equal(saved.shows[0].left, 68);
  assert.deepEqual(saved.timerVersions, version);
  writer.close(); reader.close();
  now += 1000;
  writer = createStore(filename); reader = createStore(filename);
  assert.equal(reader.getState().shows[0].left, 69);
  saved = writer.saveState({...change(reader.getState(), {status: 'Paused'}), timerCommands: ['mode']});
  now += 100000;
  assert.equal(reader.getState().shows[0].left, 69);
  saved = writer.saveState({...change(saved, {status: 'Running'}), timerCommands: ['mode']});
  now += 2000;
  assert.equal(reader.getState().shows[0].left, 71);
  assert.throws(() => reader.saveState({...saved, revision: saved.revision - 1}), error => error.status === 409);
  saved = writer.saveState({...change(reader.getState(), {left: 0, status: 'Ready'}), timerCommands: ['mode']});
  now += 5000;
  assert.equal(reader.getState().shows[0].left, 0);
  assert.equal(reader.getState().shows[0].status, 'Ready');
  const clock = change(saved, {cues: state('clock').shows[0].cues});
  saved = writer.saveState({...clock, timerCommands: ['mode']});
  now += 5000;
  assert.equal(reader.getState().revision, saved.revision);
  assert.equal(reader.getState().shows[0].cues[0].type, 'clock');
  assert.equal(reader.getState().shows[0].left, 0);
});

test('mode commands merge elapsed time and metadata but reject competing mode/cue controls', () => {
  for (const type of ['countdown', 'countup', 'clock']) {
    const base = state(type);
    const versions = {mode: ['cue', 0, 'Ready', null]};
    const local = change(base, {status: 'Running'});
    const remote = change(base, {title: 'Remote title', left: type === 'countup' ? 3 : 0});
    const merged = mergeState(base, local, remote, versions, versions);
    assert.equal(merged.shows[0].title, 'Remote title');
    assert.equal(merged.shows[0].status, 'Running');
    assert.deepEqual(timerCommands(base, local), ['mode']);
    assert.throws(() => mergeState(base, local, remote, versions,
      {mode: ['cue', 0, 'Running', 1000]}), /Timer controls/);
    const changedCue = change(remote, {cues: state(type === 'clock' ? 'countup' : 'clock').shows[0].cues});
    assert.throws(() => mergeState(base, local, changedCue, versions, versions), /active cue/);
    const modeEdit = change(base, {cues: state(type === 'clock' ? 'countup' : 'clock').shows[0].cues});
    assert.deepEqual(timerCommands(base, modeEdit), ['mode']);
    assert.throws(() => mergeState(base, modeEdit, remote, versions,
      {mode: ['cue', 0, 'Running', 1000]}), /Timer controls/);
  }
  assert.equal(clockAnchor({...state('countup').shows[0], left: 3}, 10000), 7000);
});
