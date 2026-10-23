import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from './server.mjs';
import { isStatePayload } from './lib/schema.js';
import { brandingSnapshot, DEFAULT_SETTINGS, isLogo, selectLogo, displayLogo, normalizeLogo, normalizeBrandingState } from './lib/branding.js';
import { mergeState, timerCommands } from './lib/sync.js';
import { isFont, fontBytes, MAX_FONT_BYTES } from './lib/fonts.js';

const logo = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>').toString('base64');
const light = logo.replace('base64,', 'base64,AAAA');
const dark = logo.replace('base64,', 'base64,BBBB');
const template = (id = 'saved', name = 'Conference') => ({
  id, name, templateId: 'minimal-dark', logoOn: true, uploadedLogo: logo, logoName: 'brand.svg',
  uploadedLogoLight: light, uploadedLogoDark: dark, logoNameLight: 'light.svg', logoNameDark: 'dark.svg',
});
const initial = () => ({
  revision: 0, settings: { pin: '', mainHeader: 'Event <b>team</b>', subHeader: 'Stage',
    headerLogo: logo, headerLogoName: 'brand.svg', headerLogoLight: light, headerLogoDark: dark,
    headerLogoNameLight: 'light.svg', headerLogoNameDark: 'dark.svg' }, templates: [template()],
  shows: [{ id: 'show', title: 'Show', cues: [{ id: 'cue', name: 'Opening', duration: 300 }],
    active: 'cue', left: 300, status: 'Running', templateId: 'bayer-light', logoOn: false,
    uploadedLogoLight: light, uploadedLogoDark: dark, logoNameLight: 'light.svg', logoNameDark: 'dark.svg' }],
});
const hasPHP = spawnSync('php', ['-r', 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);']).status === 0;
async function phpStore(filename) {
  const child = spawn('php', ['-S', '127.0.0.1:0', '-t', path.resolve('php')], {
    env: { ...process.env, DB_PATH: filename, STATE_PATH: path.join(path.dirname(filename), 'lem-time.json') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('PHP startup timeout')); }, 5000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stderr.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
  return {
    async getState() {
      const response = await fetch(`${base}/api.php`);
      assert.equal(response.status, 200);
      return response.json();
    },
    async saveState(data) {
      const response = await fetch(`${base}/api.php`, { method: 'PUT',
        headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status });
      return body;
    },
    async close() { child.kill(); await once(child, 'exit'); },
  };
}

test('branding schema allows old state but rejects invalid new settings/templates', () => {
  assert.equal(isStatePayload(initial()), true);
  const oversizedLegacy = 'data:image/png;base64,' + 'A'.repeat(720000);
  assert.equal(isLogo(oversizedLegacy), false);
  assert.equal(isStatePayload({ ...initial(), shows: [{ ...initial().shows[0], uploadedLogo: oversizedLegacy }] }), true);
  assert.equal(isStatePayload({ revision: 0, shows: [], settings: { pin: '' } }), true);
  for (const mode of ['Light', 'Dark']) {
    for (const invalid of ['https://untrusted/logo.svg', 'data:text/html;base64,AAAA', 4, oversizedLegacy]) {
      assert.equal(isStatePayload({...initial(), settings: {pin: '', [`headerLogo${mode}`]: invalid}}), false);
      assert.equal(isStatePayload({...initial(), templates: [{...template(), [`uploadedLogo${mode}`]: invalid}]}), false);
      assert.equal(isStatePayload({...initial(), shows: [{...initial().shows[0], [`uploadedLogo${mode}`]: invalid}]}), false);
    }
    for (const invalid of [4, 'x'.repeat(256)]) {
      assert.equal(isStatePayload({...initial(), settings: {pin: '', [`headerLogoName${mode}`]: invalid}}), false);
      assert.equal(isStatePayload({...initial(), templates: [{...template(), [`logoName${mode}`]: invalid}]}), false);
      assert.equal(isStatePayload({...initial(), shows: [{...initial().shows[0], [`logoName${mode}`]: invalid}]}), false);
    }
  }
  for (const settings of [
    { mainHeader: 4 }, { subHeader: 'x'.repeat(201) }, { headerLogo: 'https://untrusted/logo.svg' },
    { headerLogo: 'data:text/html;base64,AAAA' }, { headerLogoName: 'x'.repeat(256) },
    { headerLogo: 'data:image/png;base64,' + 'A'.repeat(700000) },
  ]) assert.equal(isStatePayload({ ...initial(), settings: { pin: '', ...settings } }), false);
  for (const templates of [
    [template(), template('other', 'conference')], [template(), template('saved', 'Different')],
    [template('one', 'Événement'), template('two', 'événement')],
    [{ ...template(), name: '  ' }], [{ ...template(), name: 'x'.repeat(81) }],
    [{ ...template(), name: 'Name\ncontrol' }],
    [{ ...template(), cues: [] }], [{ ...template(), left: 30 }],
    [{ ...template(), templateId: 'unknown' }], [{ ...template(), uploadedLogo: '<svg/>' }],
    Array.from({ length: 51 }, (_, i) => template(String(i), `Brand ${i}`)),
  ]) assert.equal(isStatePayload({ ...initial(), templates }), false);
});

test('branding snapshots are independent and never command timers; settings/templates merge safely', () => {
  const base = initial();
  const snapshot = brandingSnapshot({ ...base.shows[0], ...template() });
  assert.deepEqual(Object.keys(snapshot).sort(), ['logoName', 'logoNameDark', 'logoNameLight', 'logoOn', 'templateId', 'textFont', 'timerFont', 'uploadedLogo', 'uploadedLogoDark', 'uploadedLogoLight']);
  const applied = { ...base, shows: base.shows.map(show => ({ ...show, ...snapshot })) };
  assert.deepEqual(timerCommands(base, applied), []);
  applied.shows[0].uploadedLogo = '';
  assert.equal(snapshot.uploadedLogo, '');
  assert.equal(snapshot.uploadedLogoLight, light);
  assert.equal(snapshot.uploadedLogoDark, dark);
  const legacySnapshot = brandingSnapshot({templateId: 'bayer-light', logoOn: true, uploadedLogo: logo});
  assert.equal(legacySnapshot.uploadedLogoLight, logo);
  assert.equal(legacySnapshot.logoNameLight, '');
  assert.equal(legacySnapshot.uploadedLogoDark, '');
  const legacyApplied = {...template(), ...legacySnapshot};
  assert.equal(legacyApplied.uploadedLogoLight, logo);
  assert.equal(legacyApplied.uploadedLogoDark, '');
  const modeMerge = mergeState(base,
    {...base, settings: {...base.settings, headerLogoLight: logo},
      shows: [{...base.shows[0], uploadedLogoLight: logo}]},
    {...base, settings: {...base.settings, headerLogoDark: logo},
      shows: [{...base.shows[0], uploadedLogoDark: logo}]});
  assert.equal(modeMerge.settings.headerLogoLight, logo);
  assert.equal(modeMerge.settings.headerLogoDark, logo);
  assert.equal(modeMerge.shows[0].uploadedLogoLight, logo);
  assert.equal(modeMerge.shows[0].uploadedLogoDark, logo);
  assert.deepEqual(timerCommands(base, modeMerge), []);
  const local = { ...base, settings: { ...base.settings, mainHeader: 'Local' }, templates: [...base.templates, template('a', 'A')] };
  const remote = { ...base, settings: { ...base.settings, subHeader: 'Remote' }, templates: [...base.templates, template('b', 'B')],
    shows: base.shows.map(show => ({ ...show, left: 280 })) };
  const merged = mergeState(base, local, remote);
  assert.equal(merged.settings.mainHeader, 'Local');
  assert.equal(merged.settings.subHeader, 'Remote');
  assert.equal(merged.shows[0].left, 280);
  assert.equal(merged.templates.length, 3);
  assert.throws(() => mergeState(base, local, { ...remote, settings: { ...remote.settings, mainHeader: 'Overlap' } }), /overlap/);
  assert.throws(() => mergeState(base, local, { ...remote, templates: [...base.templates, template('b', 'a')] }), /names overlap/);
  const edited = { ...base, templates: [{ ...template(), logoOn: false }] };
  assert.throws(() => mergeState(base, edited, { ...base, templates: [{ ...template(), name: 'Remote edit' }] }), /template edits overlap/);
  assert.equal(DEFAULT_SETTINGS.mainHeader, 'Live Event Timers');
});

test('light uses only default; dark uses optional dark then default then placeholder', () => {
  assert.equal(selectLogo('light', light, dark), light);
  assert.equal(selectLogo('dark', light, dark), dark);
  assert.equal(selectLogo('light', '', dark), '');
  assert.equal(selectLogo('dark', light, ''), light);
  assert.equal(selectLogo('light', '', ''), '');
  assert.equal(selectLogo('dark', undefined, undefined), '');
  assert.equal(selectLogo('light', 'data:text/html;base64,AAAA', dark), '');
  assert.equal(selectLogo('dark', light, 'javascript:bad'), light);
  const oversizedLegacy = 'data:image/png;base64,' + 'A'.repeat(720000);
  const migrated = normalizeLogo({uploadedLogo: oversizedLegacy, logoName: 'old-large.png'});
  assert.equal(selectLogo('light', migrated.uploadedLogoLight, ''), oversizedLegacy, 'old larger uploads still display');
  assert.equal(isStatePayload({...initial(), shows: [{...initial().shows[0], ...migrated}]}), true);
  const unsupported = normalizeLogo({uploadedLogo: 'old-unsupported-asset', logoName: 'original.file'});
  assert.equal(isStatePayload({...initial(), shows: [{...initial().shows[0], ...unsupported}]}), true);
  assert.equal(selectLogo('light', unsupported.uploadedLogoLight, dark), '');
  for (const [templateId, expected] of [['bayer-light', light], ['bayer-blue', dark], ['minimal-dark', dark], ['unknown', light]]) {
    assert.equal(displayLogo({...template(), templateId}), expected);
  }
});

test('normalization migrates old assets and filenames, favors explicit light and clears stale fallback', () => {
  for (const [image, name] of [['uploadedLogo', 'logoName'], ['headerLogo', 'headerLogoName']]) {
    const old = {[image]: logo, [name]: 'original.svg', [`${image}Light`]: '', [`${name}Light`]: ''};
    const migrated = normalizeLogo(old, image, name);
    assert.equal(migrated[`${image}Light`], logo);
    assert.equal(migrated[`${name}Light`], 'original.svg');
    assert.equal(migrated[image], '');
    assert.deepEqual(normalizeLogo(migrated, image, name), migrated);
    const newer = normalizeLogo({...old, [`${image}Light`]: light, [`${name}Light`]: 'new.svg'}, image, name);
    assert.equal(newer[`${image}Light`], light);
    assert.equal(newer[`${name}Light`], 'new.svg');
    const removed = {...migrated, [`${image}Light`]: '', [`${name}Light`]: ''};
    assert.equal(normalizeLogo(JSON.parse(JSON.stringify(removed)), image, name)[`${image}Light`], '');
    assert.equal(normalizeLogo(old, image, name, removed)[`${image}Light`], '', 'old payload cannot revive a deleted slot');
  }
  const old = {...initial(), shows: [{...initial().shows[0], uploadedLogo: logo, logoName: 'old.svg',
    uploadedLogoLight: '', logoNameLight: ''}]};
  const migrated = normalizeBrandingState(old);
  const removed = {...migrated, shows: [{...migrated.shows[0], uploadedLogoLight: '', logoNameLight: ''}]};
  const remote = {...old, settings: {...old.settings, mainHeader: 'Remote edit'}};
  const merged = mergeState(old, removed, remote);
  assert.equal(merged.shows[0].uploadedLogoLight, '');
  assert.equal(merged.settings.mainHeader, 'Remote edit');
  assert.deepEqual(timerCommands(old, merged), []);
});

// Small structurally valid headers exercise server validation without embedding licensed fonts.
function fontFixture(format = 'ttf', change = () => {}) {
  const bytes = Buffer.alloc(format === 'woff' ? 68 : format === 'woff2' ? 52 : 32);
  if (format === 'ttf' || format === 'otf') {
    bytes.writeUInt32BE(format === 'ttf' ? 0x00010000 : 0x4f54544f, 0);
    bytes.writeUInt16BE(1, 4); bytes.write('test', 12);
    bytes.writeUInt32BE(28, 20); bytes.writeUInt32BE(4, 24);
  } else {
    bytes.write(format === 'woff2' ? 'wOF2' : 'wOFF', 0);
    bytes.writeUInt32BE(0x00010000, 4); bytes.writeUInt32BE(bytes.length, 8);
    bytes.writeUInt16BE(1, 12); bytes.writeUInt32BE(32, 16);
    if (format === 'woff2') bytes.writeUInt32BE(2, 20);
    else {
      bytes.write('test', 44); bytes.writeUInt32BE(64, 48);
      bytes.writeUInt32BE(4, 52); bytes.writeUInt32BE(4, 56);
    }
  }
  change(bytes);
  return {name: `test.${format}`, data: `data:font/${format};base64,${bytes.toString('base64')}`};
}
function invalidFonts() {
  const valid = fontFixture();
  return [
    '', false, [], {}, {data: valid.data}, {...valid, extra: true},
    {...valid, name: ''}, {...valid, name: 'a'.repeat(256)}, {...valid, name: 'bad\nfont'},
    {...valid, data: 'https://example.com/font.ttf'},
    {...valid, data: valid.data.replace('font/ttf', 'text/html')},
    {...valid, data: valid.data.replace('font/ttf', 'font/otf')},
    {...valid, data: valid.data + '\n'}, {...valid, data: valid.data.slice(0, -1)},
    {...valid, data: 'data:font/ttf;base64,AAAB'},
    {...valid, data: 'data:font/ttf;base64,' + Buffer.alloc(MAX_FONT_BYTES + 1).toString('base64')},
    fontFixture('ttf', b => b.writeUInt16BE(0, 4)),
    fontFixture('ttf', b => b.writeUInt16BE(257, 4)),
    fontFixture('ttf', b => b.writeUInt32BE(4, 20)),
    fontFixture('ttf', b => b.writeUInt32BE(0xffffffff, 24)),
    fontFixture('woff', b => b.writeUInt32BE(70, 8)),
    fontFixture('woff', b => b.writeUInt16BE(1, 14)),
    fontFixture('woff', b => b.writeUInt32BE(12, 48)),
    fontFixture('woff', b => b.writeUInt32BE(8, 52)),
    fontFixture('woff', b => b.writeUInt32BE(0xffffffff, 16)),
    fontFixture('woff2', b => b.writeUInt32BE(0, 20)),
    fontFixture('woff2', b => b.writeUInt32BE(60, 20)),
    fontFixture('woff2', b => { b.writeUInt32BE(50, 28); b.writeUInt32BE(10, 32); }),
    fontFixture('woff2', b => b.writeUInt32BE(0xffffffff, 36)),
  ];
}
test('font formats enforce canonical data URLs, binary bounds and independent branding snapshots', () => {
  assert.equal(isFont(null), true);
  for (const format of ['ttf', 'otf', 'woff', 'woff2']) {
    const font = fontFixture(format);
    assert.equal(isFont(font), true, format);
    assert.ok(fontBytes(font.data));
    const state = initial(); state.shows[0].timerFont = font; state.templates[0].textFont = font;
    assert.equal(isStatePayload(state), true);
  }
  for (const font of invalidFonts()) {
    assert.equal(isFont(font), false, JSON.stringify(font).slice(0, 120));
    const state = initial(); state.shows[0].timerFont = font;
    assert.equal(isStatePayload(state), false);
    const snapshot = initial(); snapshot.templates[0].textFont = font;
    assert.equal(isStatePayload(snapshot), false);
  }
  const base = initial(), font = fontFixture();
  const local = {...base, shows: [{...base.shows[0], timerFont: font}]};
  const remote = {...base, shows: [{...base.shows[0], textFont: fontFixture('otf')}]};
  const merged = mergeState(base, local, remote);
  assert.deepEqual(merged.shows[0].timerFont, font);
  assert.deepEqual(merged.shows[0].textFont, remote.shows[0].textFont);
  assert.deepEqual(timerCommands(base, merged), []);
  const snapshot = brandingSnapshot(merged.shows[0]);
  snapshot.timerFont.name = 'different.ttf';
  assert.equal(merged.shows[0].timerFont.name, 'test.ttf');
  assert.equal(brandingSnapshot(base.shows[0]).timerFont, null);
});

for (const backend of ['Node', 'PHP']) {
  test(`${backend} validates and persists independent fonts, snapshots, old clients and explicit removal`, {skip: backend === 'PHP' && !hasPHP}, async t => {
    const dir = mkdtempSync(path.join(process.cwd(), '.test-fonts-'));
    const filename = path.join(dir, 'state.db');
    let store;
    t.after(async () => { if (store) await store.close(); rmSync(dir, {recursive: true, force: true}); });
    const open = () => backend === 'PHP' ? phpStore(filename) : createStore(filename);
    store = await open();
    const seed = initial();
    seed.shows[0].timerFont = fontFixture('woff');
    seed.shows[0].textFont = fontFixture('otf');
    seed.templates = [{id: 'fonts', name: 'Fonts', ...brandingSnapshot(seed.shows[0])}];
    let saved = await store.saveState(seed);
    const versions = saved.timerVersions;
    for (const font of invalidFonts()) {
      await assert.rejects(async () => store.saveState({...saved, timerCommands: [],
        shows: [{...saved.shows[0], timerFont: font}]}), error => error.status === 400);
      await assert.rejects(async () => store.saveState({...saved, timerCommands: [],
        templates: [{...saved.templates[0], textFont: font}]}), error => error.status === 400);
    }
    for (const format of ['ttf', 'otf', 'woff', 'woff2']) {
      saved = await store.saveState({...saved, timerCommands: [],
        shows: [{...saved.shows[0], timerFont: fontFixture(format)}]});
      assert.deepEqual(saved.timerVersions, versions);
    }
    const omit = ({timerFont, textFont, ...value}) => value;
    saved = await store.saveState({...saved, timerCommands: [],
      shows: saved.shows.map(omit), templates: saved.templates.map(omit)});
    assert.deepEqual(saved.shows[0].timerFont, fontFixture('woff2'));
    assert.deepEqual(saved.shows[0].textFont, fontFixture('otf'));
    await store.close(); store = await open();
    saved = await store.getState();
    assert.deepEqual(saved.templates[0].timerFont, fontFixture('woff'));
    assert.deepEqual(saved.templates[0].textFont, fontFixture('otf'));
    const applied = {...saved.shows[0], ...brandingSnapshot(saved.templates[0])};
    saved = await store.saveState({...saved, timerCommands: [], shows: [applied]});
    assert.deepEqual(saved.shows[0].timerFont, fontFixture('woff'));
    saved = await store.saveState({...saved, timerCommands: [], shows: [{...applied, timerFont: null, textFont: null}],
      templates: [{...saved.templates[0], timerFont: null, textFont: null}]});
    await store.saveState({...saved, timerCommands: [], shows: saved.shows.map(omit), templates: saved.templates.map(omit)});
    await store.close(); store = await open();
    const reloaded = await store.getState();
    for (const value of [reloaded.shows[0], reloaded.templates[0]]) {
      assert.equal(value.timerFont, null); assert.equal(value.textFont, null);
    }
    assert.deepEqual(reloaded.timerVersions, versions);
  });
  test(`${backend} migrates JSON/SQLite defaults and never resurrects removed assets from old payloads`, {skip: backend === 'PHP' && !hasPHP}, async t => {
    const dir = mkdtempSync(path.join(process.cwd(), '.test-branding-default-'));
    const filename = path.join(dir, 'state.db');
    let store;
    t.after(async () => { if (store) await store.close(); rmSync(dir, {recursive: true, force: true}); });
    const open = () => backend === 'PHP' ? phpStore(filename) : createStore(filename);
    const oldBranding = {uploadedLogo: logo, logoName: 'original.svg', uploadedLogoLight: '', logoNameLight: ''};
    const legacy = {...initial(), initialized: true, revision: 7,
      settings: {pin: '', headerLogo: logo, headerLogoName: 'header-original.svg'},
      shows: [{...initial().shows[0], ...oldBranding}],
      templates: [{id: 'old', name: 'Old branding', templateId: 'bayer-light', logoOn: true, ...oldBranding}]};
    writeFileSync(path.join(dir, 'lem-time.json'), JSON.stringify(legacy));
    store = await open();
    const migrated = await store.getState();
    for (const value of [migrated.shows[0], migrated.templates[0]]) {
      assert.equal(value.uploadedLogoLight, logo);
      assert.equal(value.logoNameLight, 'original.svg');
      assert.equal(value.uploadedLogo, '');
    }
    assert.equal(migrated.settings.headerLogoLight, logo);
    assert.equal(migrated.settings.headerLogoNameLight, 'header-original.svg');
    const removed = await store.saveState({...migrated, timerCommands: [],
      settings: {...migrated.settings, headerLogoLight: '', headerLogoNameLight: ''},
      shows: migrated.shows.map(value => ({...value, uploadedLogoLight: '', logoNameLight: ''})),
      templates: migrated.templates.map(value => ({...value, uploadedLogoLight: '', logoNameLight: ''}))});
    // A current-revision old client has no slots and still holds its old logo.
    const omitSlots = value => Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:Light|Dark)$/.test(key)));
    await store.saveState({...removed, timerCommands: [],
      settings: omitSlots({...removed.settings, headerLogo: logo, headerLogoName: 'stale.svg'}),
      shows: removed.shows.map(value => omitSlots({...value, uploadedLogo: logo, logoName: 'stale.svg'})),
      templates: removed.templates.map(value => omitSlots({...value, uploadedLogo: logo, logoName: 'stale.svg'}))});
    await store.close(); store = await open();
    const reloaded = await store.getState();
    assert.equal(reloaded.settings.headerLogoLight, '');
    for (const value of [reloaded.shows[0], reloaded.templates[0]]) {
      assert.equal(value.uploadedLogoLight, '');
      assert.equal(value.uploadedLogo, '');
    }
    assert.deepEqual(reloaded.timerVersions, migrated.timerVersions);
    await store.close(); store = null;
    // Simulate an existing SQLite database predating the two-slot UI.
    const db = new DatabaseSync(filename);
    db.prepare('UPDATE site_settings SET data = ?').run(JSON.stringify(legacy.settings));
    db.prepare('UPDATE shows SET metadata = ?').run(JSON.stringify({...legacy.shows[0], cues: undefined}));
    db.prepare('UPDATE branding_templates SET data = ?').run(JSON.stringify(legacy.templates[0]));
    db.close();
    store = await open();
    const upgraded = await store.getState();
    assert.equal(upgraded.settings.headerLogoLight, logo);
    assert.equal(upgraded.shows[0].uploadedLogoLight, logo);
    assert.equal(upgraded.templates[0].logoNameLight, 'original.svg');
    const resaved = await store.saveState({...upgraded, timerCommands: []});
    assert.equal(resaved.shows[0].uploadedLogo, '');
    assert.equal(resaved.templates[0].uploadedLogo, '');
  });

  test(`${backend} persists settings/templates, protects conflicts and old clients, restarts and backs up`, { skip: backend === 'PHP' && !hasPHP }, async t => {
    const dir = mkdtempSync(path.join(process.cwd(), '.test-branding-'));
    const filename = path.join(dir, 'state.db');
    let store;
    t.after(async () => { if (store) await store.close(); rmSync(dir, { recursive: true, force: true }); });
    const open = () => backend === 'PHP' ? phpStore(filename) : createStore(filename);
    store = await open();
    const saved = await store.saveState(initial());
    assert.deepEqual(saved.templates, normalizeBrandingState(initial()).templates);
    assert.deepEqual(saved.settings, normalizeBrandingState(initial()).settings);
    assert.equal(saved.shows[0].uploadedLogoLight, light);
    assert.equal(saved.shows[0].uploadedLogoDark, dark);
    const clock = saved.timerVersions.show;
    const oldClient = await store.saveState({
      revision: saved.revision, settings: { pin: '' }, shows: saved.shows, timerCommands: [],
    });
    assert.equal(oldClient.settings.mainHeader, initial().settings.mainHeader);
    assert.deepEqual(oldClient.templates, normalizeBrandingState(initial()).templates);
    assert.deepEqual(oldClient.timerVersions.show, clock);
    await assert.rejects(async () => store.saveState(initial()), error => error.status === 409);
    await assert.rejects(async () => store.saveState({ ...oldClient, templates: [{ ...template(), name: '' }] }), error => error.status === 400);
    await assert.rejects(async () => store.saveState({ ...oldClient, templates: [template('one', 'Événement'), template('two', 'événement')] }), error => error.status === 400);
    await assert.rejects(async () => store.saveState({ ...oldClient, settings: { ...oldClient.settings, mainHeader: '😀'.repeat(101) } }), error => error.status === 400);
    for (const mode of ['Light', 'Dark']) {
      await assert.rejects(async () => store.saveState({...oldClient, templates: [{...template(), [`uploadedLogo${mode}`]: 'javascript:bad'}]}), error => error.status === 400);
      await assert.rejects(async () => store.saveState({...oldClient, settings: {...oldClient.settings, [`headerLogo${mode}`]: 'data:text/html;base64,AAAA'}}), error => error.status === 400);
      await assert.rejects(async () => store.saveState({...oldClient, shows: [{...oldClient.shows[0], [`logoName${mode}`]: 'x'.repeat(256)}]}), error => error.status === 400);
    }
    await store.close(); store = null;
    store = await open();
    assert.deepEqual((await store.getState()).templates, normalizeBrandingState(initial()).templates);
    assert.deepEqual((await store.getState()).settings, oldClient.settings);
    assert.equal((await store.getState()).shows[0].uploadedLogoDark, dark);
    const db = new DatabaseSync(filename, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM branding_templates').get().n, 1);
    assert.match(db.prepare('SELECT data FROM site_settings').get().data, /Event/);
    db.close();
    const backup = createStore(`${filename}.bak`);
    assert.deepEqual(backup.getState().templates, normalizeBrandingState(initial()).templates);
    assert.deepEqual(backup.getState().settings, normalizeBrandingState(initial()).settings);
    assert.equal(backup.getState().shows[0].uploadedLogoLight, light);
    backup.close();
    if (process.platform !== 'win32') {
      assert.equal(statSync(filename).mode & 0o077, 0);
      assert.equal(statSync(`${filename}.bak`).mode & 0o077, 0);
    }
    const reset = await store.saveState({ ...await store.getState(), settings: { pin: '', ...DEFAULT_SETTINGS }, templates: [], timerCommands: [] });
    assert.deepEqual(reset.settings, { pin: '', ...DEFAULT_SETTINGS });
    assert.deepEqual(reset.templates, []);
    assert.deepEqual(reset.timerVersions.show, clock);
  });

  test(`${backend} upgrades old SQLite and imports private branding JSON only once`, { skip: backend === 'PHP' && !hasPHP }, async t => {
    const dir = mkdtempSync(path.join(process.cwd(), '.test-branding-import-'));
    const filename = path.join(dir, 'state.db');
    let store;
    t.after(async () => { if (store) await store.close(); rmSync(dir, { recursive: true, force: true }); });
    const open = () => backend === 'PHP' ? phpStore(filename) : createStore(filename);
    const legacy = { ...initial(), revision: 19, initialized: true };
    const json = path.join(dir, 'lem-time.json');
    writeFileSync(json, JSON.stringify(legacy));
    store = await open();
    const imported = await store.getState();
    assert.equal(imported.revision, 19);
    assert.deepEqual(imported.templates, normalizeBrandingState(legacy).templates);
    assert.deepEqual(imported.settings, normalizeBrandingState(legacy).settings);
    assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), legacy);
    await store.close(); store = null;
    writeFileSync(json, 'broken JSON must be ignored once initialized');
    store = await open();
    assert.equal((await store.getState()).revision, 19);
    await store.close(); store = null;
    const db = new DatabaseSync(filename);
    db.exec('DROP TABLE branding_templates; DROP TABLE site_settings');
    db.close();
    store = await open();
    const upgraded = await store.getState();
    assert.equal(upgraded.revision, 19);
    assert.equal(upgraded.settings.pin, legacy.settings.pin);
    assert.deepEqual(upgraded.templates, []);
    assert.equal(upgraded.shows[0].title, 'Show');
  });
}
