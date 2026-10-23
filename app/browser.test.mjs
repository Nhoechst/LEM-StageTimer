import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertState } from './state-test-helpers.mjs';

// Direct concurrent test writes use a real, independently authorized operator.
const apiOperator = '0123456789abcdef0123456789abcdef';
let apiCookie = '';
async function apiAction(base, action, pin) {
  const response = await fetch(`${base}/api.php`, {method: 'POST',
    headers: {Origin: new URL(base).origin, 'Content-Type': 'application/json', 'X-Operator-ID': apiOperator, Cookie: apiCookie},
    body: JSON.stringify({action, pin})});
  assert.equal(response.status, 200, await response.text());
  if (response.headers.has('set-cookie')) apiCookie = response.headers.get('set-cookie').split(';')[0];
}
const apiHeaders = base => ({Origin: new URL(base).origin, 'Content-Type': 'application/json', 'X-Operator-ID': apiOperator, Cookie: apiCookie});

// Optional integration check using an installed ChromeDriver and an isolated,
// initially empty Pelican build. No browser-test dependencies are required.
const enabled = Boolean(process.env.CHROMEDRIVER_URL && process.env.BROWSER_TEST_URL);
function windowClicks(command, prefix, run, click, instrument = async () => {}) {
  const parents = [];
  return async text => {
    if (text === 'Back to Show' && parents.length) {
      const {parent, child} = parents.pop();
      await command('POST', `${prefix}/window`, {handle: child});
      await command('DELETE', `${prefix}/window`);
      await command('POST', `${prefix}/window`, {handle: parent});
      return;
    }
    const view = {'Preview display': 'display', 'Open DSM': 'dsm-preview', 'Open Chroma mode': 'chroma'}[text];
    if (!view) return click(text);
    const parent = await command('GET', `${prefix}/window`);
    const before = await command('GET', `${prefix}/window/handles`);
    const original = await run('window.workspaceNode=document.querySelector(\'[aria-label="Current timer value"]\');return location.href');
    await run(`window.nativeOpen ||= window.open; window.outputOpenCall=null;
      window.open=(url,target,features)=>{
        window.outputOpenCall={url,target,features,gesture:navigator.userActivation.isActive};
        return window.nativeOpen.call(window,url,target,features);
      }`);
    const element = await command('POST', `${prefix}/element`, {using: 'xpath', value: `//button[normalize-space(.)="${text}"]`});
    await command('POST', `${prefix}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
    let child;
    for (let attempt = 0; attempt < 60 && !child; attempt++) {
      child = (await command('GET', `${prefix}/window/handles`)).find(handle => !before.includes(handle));
      if (!child) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(child, `${text} must open a separate browser window`);
    assert.equal(await run('return location.href'), original, 'opening outputs leaves the workspace URL untouched');
    assert.equal(await run('return window.workspaceNode===document.querySelector(\'[aria-label="Current timer value"]\')'), true);
    const opened = await run('return window.outputOpenCall');
    assert.equal(opened.gesture, true, 'window.open runs synchronously in the click gesture');
    assert.equal(opened.target, '_blank');
    assert.match(opened.features, /noopener/);
    assert.match(opened.features, /width=\d+/);
    assert.match(opened.features, /height=\d+/);
    assert.match(opened.features, /popup=yes/);
    parents.push({parent, child});
    await command('POST', `${prefix}/window`, {handle: child});
    await command('POST', `${prefix}/window/rect`, {width: 1280, height: 900});
    const expected = new URL(original);
    expected.hash = expected.hash.replace(/^#\/control\//, `#/${view}/`);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await run('return !!document.querySelector("section .font-mono")')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await run('return location.href'), expected.href);
    assert.equal(await run('return window.opener===null'), true);
    await instrument();
    await command('POST', `${prefix}/refresh`, {});
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await run('return !!document.querySelector("section .font-mono")')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await run('return location.href'), expected.href, 'reload preserves output routing');
    assert.equal(await run(`return !window.requests||window.requests.every(request=>(typeof request==='string'?request:request.method)==='GET')`), true,
      'output windows only poll shared backend state');
    if (view === 'chroma') assert.equal(await run('return !!document.querySelector(\'[aria-label="Expand Chroma display"]\')'), true);
    if (view === 'dsm-preview') assert.equal(await run('return !!document.querySelector(\'[aria-label="Expand DSM display"]\')'), true);
  };
}
async function browserModes(t) {
  const driver = process.env.CHROMEDRIVER_URL, base = process.env.BROWSER_TEST_URL;
  const profile = path.resolve('.browser-data/modes-profile');
  mkdirSync(profile, {recursive: true});
  const command = async (method, endpoint, data) => {
    const response = await fetch(`${driver}${endpoint}`, {
      method, headers: {'Content-Type': 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result.value;
  };
  const session = await command('POST', '/session', {capabilities: {alwaysMatch: {
    browserName: 'chrome', 'goog:chromeOptions': {args: [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profile}`,
    ]},
  }}});
  const prefix = `/session/${session.sessionId}`;
  t.after(() => command('DELETE', prefix));
  const run = script => command('POST', `${prefix}/execute/sync`, {script, args: []});
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => {
    const deadline = Date.now() + 6000;
    while (!(await predicate())) {
      if (Date.now() >= deadline) assert.fail(`mode browser condition timed out: ${await run('return document.body.innerText')}`);
      await wait(50);
    }
  };
  const navigate = hash => command('POST', `${prefix}/url`, {url: `${base}/${hash}`});
  const get = () => fetch(`${base}/api.php`).then(response => response.json());
  const save = async data => {
    const response = await fetch(`${base}/api.php`, {method: 'PUT',
      headers: apiHeaders(base), body: JSON.stringify(data)});
    assert.equal(response.status, 200);
    return response.json();
  };
  const original = await get();
  const seed = {id: 'modes', title: 'Cue modes', active: 'legacy', left: 30, status: 'Ready',
    cues: [{id: 'legacy', name: 'Legacy countdown', duration: 30}], templateId: 'bayer-blue', logoOn: false};
  await save({revision: original.revision, settings: {pin: ''}, shows: [seed], timerCommands: ['modes']});
  const click = windowClicks(command, prefix, run, text => run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`), () => instrument());
  const field = (selector, value, kind = 'input') => run(`
    const node=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(${kind === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(node,${JSON.stringify(value)});
    node.dispatchEvent(new Event('${kind === 'select' ? 'change' : 'input'}',{bubbles:true}));
  `);
  const instrument = () => command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Page.addScriptToEvaluateOnNewDocument', params: {source: `
    window.requests=[];window.browserErrors=[];
    window.addEventListener('error',e=>window.browserErrors.push(e.message));
    const original=window.fetch;window.fetch=(...args)=>{window.requests.push(args[1]?.method||'GET');return original(...args)};
  `}});
  await instrument();
  await command('POST', `${prefix}/url`, {url: `${base}/?tenant=one%20two#/control/modes`});
  await until(() => run('return !!document.querySelector(\'[aria-label="Current timer value"]\')'));
  assert.equal(await run(`return Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Delete Show')`), false);
  assert.equal(await run(`const links=document.querySelector('[aria-label="Show links"]');return !links.closest('aside')&&links.previousElementSibling.innerText.includes('Show cues')`), true);
  const addCue = async (type, name) => {
    await click('Add Cue');
    await field('[role="dialog"] input', name);
    assert.equal(await run(`return document.querySelector('[aria-label="Cue type"]').value`), 'countdown');
    await field('[aria-label="Cue type"]', type, 'select');
    if (type === 'clock') assert.equal(await run(`return document.querySelectorAll('[role="dialog"] input[type="number"]').length`), 0);
    if (type === 'countup') {
      assert.deepEqual(await run(`return Array.from(document.querySelectorAll('[role="dialog"] input[type="number"]')).map(i=>i.value)`), ['0', '0']);
      await field('[role="dialog"] input[type="number"]', '1');
      await field('[role="dialog"] input[max="59"]', '5');
    }
    await click('Save Cue');
    await until(async () => (await get()).shows[0].cues.some(c => c.name === name));
    await run(`const name=Array.from(document.querySelectorAll('b')).find(b=>b.textContent===${JSON.stringify(name)});Array.from(name.parentElement.parentElement.querySelectorAll('button')).find(b=>b.textContent==='Activate').click()`);
    await until(async () => {
      const show = (await get()).shows[0];
      return show.cues.find(c => c.id === show.active)?.type === type;
    });
  };
  await addCue('clock', 'Wall time');
  assert.doesNotMatch(await run('return document.body.innerText'), /Set remaining time/);
  assert.equal(await run(`return Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Start'||b.textContent==='Reset')`), false);
  const clockValue = () => run(`return document.querySelector('[aria-label="Current timer value"]').textContent`);
  assert.match(await clockValue(), /^\d\d:\d\d:\d\d$/);
  assert.equal(await run(`const shown=document.querySelector('[aria-label="Current timer value"]').textContent;return [0,-1000].some(offset=>{const now=new Date(Date.now()+offset);return shown===[now.getHours(),now.getMinutes(),now.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':')})`), true);
  const revision = (await get()).revision;
  await run('window.requests=[]');
  const beforeClock = await clockValue();
  await wait(1300);
  assert.notEqual(await clockValue(), beforeClock);
  assert.equal((await get()).revision, revision);
  assert.ok((await run('return window.requests')).every(method => method === 'GET'));
  assert.equal(await run(`const chip=document.querySelector('[aria-label="Current timer value"]').nextElementSibling;return chip.children.length===1&&chip.textContent==='Local Time'`), true);
  const editTimeFormat = async format => {
    await run(`const name=Array.from(document.querySelectorAll('b')).find(b=>b.textContent==='Wall time');Array.from(name.parentElement.parentElement.querySelectorAll('button')).find(b=>b.textContent==='Edit').click()`);
    assert.equal(await run(`return document.querySelector('[aria-label="Cue type"] option[value="clock"]').textContent`), 'Local Time');
    await field('[aria-label="Time format"]', format, 'select');
    await click('Save Cue');
    await until(async () => (await get()).shows[0].cues.find(cue => cue.type === 'clock').clockFormat === format);
  };
  const beforeFormat = (await get()).timerVersions.modes;
  await editTimeFormat('12h');
  assert.deepEqual((await get()).timerVersions.modes, beforeFormat, 'format-only edits must not reset a timer');
  assert.match(await clockValue(), /^\d\d:\d\d:\d\d [AP]M$/);
  await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Emulation.setDeviceMetricsOverride',
    params: {width: 320, height: 800, deviceScaleFactor: 1, mobile: false}});
  const timeFits = () => run(`return [...document.querySelectorAll('.local-time-value')].every(node=>{const box=node.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth})`);
  assert.equal(await timeFits(), true, '12-hour workspace values must fit narrow screens');
  await click('Preview display');
  assert.match(await run(`return document.querySelector('section .font-mono').textContent`), /^\d\d:\d\d:\d\d [AP]M$/);
  assert.equal(await timeFits(), true);
  await click('Back to Show');
  await click('← All Shows');
  assert.match(await run(`return document.querySelector('[aria-label="Live normal display thumbnail"] .font-mono').textContent`), /^\d\d:\d\d:\d\d [AP]M$/);
  await run(`document.querySelector('[aria-label="Open Cue modes"]').click()`);
  await command('POST', `${prefix}/refresh`, {});
  await until(() => run(`return !!document.querySelector('[aria-label="Current timer value"]')`));
  assert.match(await clockValue(), /^\d\d:\d\d:\d\d [AP]M$/);
  const control = await command('GET', `${prefix}/window`);
  const viewer = await command('POST', `${prefix}/window/new`, {type: 'tab'});
  await command('POST', `${prefix}/window`, {handle: viewer.handle});
  await instrument();
  for (const route of ['#/display/modes', '#/dsm/modes']) {
    await navigate(route);
    await until(() => run(`return !!document.querySelector('section .font-mono')`));
    assert.match(await run(`return document.querySelector('section .font-mono').textContent`), /^\d\d:\d\d:\d\d [AP]M$/);
    assert.equal(await run(`return document.querySelectorAll('section [aria-hidden="true"]').length`), 0);
    assert.ok((await run('return window.requests')).every(method => method === 'GET'));
  }
  await command('POST', `${prefix}/window`, {handle: control});
  await click('Open Chroma mode');
  assert.match(await run(`return document.querySelector('section span.font-mono').textContent`), /^\d\d:\d\d:\d\d [AP]M$/);
  assert.equal(await timeFits(), true);
  await click('Back to Show');
  await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Emulation.clearDeviceMetricsOverride', params: {}});
  await editTimeFormat('24h');
  assert.match(await clockValue(), /^\d\d:\d\d:\d\d$/);
  await addCue('countup', 'Elapsed');
  assert.equal(await clockValue(), '1:05');
  assert.doesNotMatch(await run('return document.body.innerText'), /Set remaining time/);
  await click('Start');
  await until(async () => (await get()).shows[0].status === 'Running');
  await wait(1400);
  assert.notEqual(await clockValue(), '1:05');
  await click('Pause');
  await until(async () => (await get()).shows[0].status === 'Paused');
  const paused = (await get()).shows[0].left;
  await wait(1100);
  assert.equal((await get()).shows[0].left, paused);
  await command('POST', `${prefix}/window`, {handle: viewer.handle});
  await until(() => run(`return document.querySelector('[aria-label="DSM output"] span')?.textContent===${JSON.stringify(`${Math.floor(paused/60)}:${String(paused%60).padStart(2, '0')}`)}`));
  assert.ok((await run('return window.requests')).every(method => method === 'GET'));
  await command('POST', `${prefix}/window`, {handle: control});
  for (const [button, selector] of [['Preview display', 'section .font-mono'], ['Open DSM', '[aria-label="DSM output"] span'], ['Open Chroma mode', 'section span.font-mono']]) {
    await click(button);
    assert.equal(await run(`return document.querySelector('${selector}').textContent`), `${Math.floor(paused/60)}:${String(paused%60).padStart(2, '0')}`);
    assert.ok((await run('return window.requests.slice(-2)')).every(method => method === 'GET'));
    await click('Back to Show');
  }
  await click('Reset');
  await until(async () => (await get()).shows[0].left === 65);
  assert.equal(await clockValue(), '1:05');
  // Editing an active mode resets it; adding the next cue never reuses the previous type.
  await click('Start');
  await until(async () => (await get()).shows[0].status === 'Running');
  await run(`const name=Array.from(document.querySelectorAll('b')).find(b=>b.textContent==='Elapsed');Array.from(name.parentElement.parentElement.querySelectorAll('button')).find(b=>b.textContent==='Edit').click()`);
  assert.equal(await run(`return document.querySelector('[aria-label="Cue type"]').value`), 'countup');
  await field('[aria-label="Cue type"]', 'countdown', 'select');
  await click('Save Cue');
  await until(async () => (await get()).shows[0].cues.find(c => c.name === 'Elapsed').type === 'countdown');
  assert.equal((await get()).shows[0].status, 'Ready');
  assert.equal((await get()).shows[0].left, 65);
  assert.match(await run('return document.body.innerText'), /Set remaining time/);
  await click('Add Cue');
  assert.equal(await run(`return document.querySelector('[aria-label="Cue type"]').value`), 'countdown');
  await command('POST', `${prefix}/actions`, {actions: [{type:'key',id:'keyboard',actions:[{type:'keyDown',value:'\uE00C'},{type:'keyUp',value:'\uE00C'}]}]});
  const key = value => command('POST', `${prefix}/actions`, {actions: [{
    type: 'key', id: 'keyboard', actions: [{type: 'keyDown', value}, {type: 'keyUp', value}],
  }]});
  const realClick = async selector => {
    const element = await command('POST', `${prefix}/element`, {using: 'css selector', value: selector});
    await command('POST', `${prefix}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
  };
  const cardPoint = async selector => {
    const point = await run(`const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+5,y:r.top+5}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Input.dispatchMouseEvent',
        params: {type, ...point, button: 'left', clickCount: 1}});
    }
  };
  const dashboardOnly = async () => assert.equal(await run(`return !!document.querySelector('article')&&!document.querySelector('[aria-label="Timer panel"]')`), true);
  const noDashboardPinRow = async () => assert.equal(await run(`return [...document.querySelectorAll('button')].some(b=>['Unlock this window','Lock this window','Configure PIN lock','Change or remove PIN'].includes(b.textContent.trim()))`), false);
  await click('← All Shows');
  await noDashboardPinRow();
  assert.equal(await run(`const a=document.querySelector('article a');return a.tagName==='A'&&a.hash==='#/control/modes'&&!a.querySelector('button,input')&&!a.closest('[role="button"]')`), true);
  assert.equal(await run(`return !!document.querySelector('button[aria-label="Open Cue modes"]')`), false);
  for (const selector of ['article [aria-label="Live normal display thumbnail"]', 'article h3', 'article']) {
    await cardPoint(selector);
    await until(() => run(`return !!document.querySelector('[aria-label="Timer panel"]')`));
    await click('← All Shows');
  }
  await run(`document.querySelector('article a').focus()`);
  assert.equal(await run(`return getComputedStyle(document.activeElement).boxShadow!=='none'`), true);
  await key('\uE007');
  await until(() => run(`return !!document.querySelector('[aria-label="Timer panel"]')`));
  await click('← All Shows');
  await realClick('[aria-label="Edit title for Cue modes"]');
  await dashboardOnly();
  await realClick('[aria-label="Show display title"]');
  const longTitle = 'A very long mobile show title with an unbroken segment ' + 'Show'.repeat(25);
  await field('[aria-label="Show display title"]', longTitle);
  await key('\uE007');
  await until(async () => (await get()).shows[0].title === longTitle);
  await dashboardOnly();
  for (const width of [1000, 320]) {
    await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Emulation.setDeviceMetricsOverride',
      params: {width, height: 900, deviceScaleFactor: 1, mobile: false}});
    assert.equal(await run(`const title=document.querySelector('article h3').getBoundingClientRect(),edit=document.querySelector('article button[aria-label^="Edit title"]').getBoundingClientRect();return Math.abs(title.top-edit.top)<5&&edit.left-title.right<=8&&edit.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth`), true, `title and adjacent pencil must fit at ${width}px`);
  }
  await realClick('article button[aria-label^="Edit title"]');
  await field('[aria-label="Show display title"]', 'Cue modes');
  await realClick('article a');
  await until(async () => (await get()).shows[0].title === 'Cue modes');
  await dashboardOnly(); // The blur/save click must not also open the show.
  await realClick('[aria-label="Edit title for Cue modes"]');
  await field('[aria-label="Show display title"]', 'Discard this edit');
  await key('\uE00C');
  await dashboardOnly();
  assert.equal((await get()).shows[0].title, 'Cue modes');
  await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Emulation.clearDeviceMetricsOverride', params: {}});
  await realClick('[aria-label="Show actions for Cue modes"]');
  await realClick('article a');
  await dashboardOnly();
  assert.equal(await run(`return !!document.querySelector('[role="menu"]')`), false);
  await realClick('[aria-label="Show actions for Cue modes"]');
  await key('\uE00C');
  assert.equal(await run(`return document.activeElement.getAttribute('aria-label')`), 'Show actions for Cue modes');
  await key('\uE007');
  for (const label of ['Pin to top', 'Unpin from top', 'Duplicate']) {
    await realClick(`[role="menuitem"]:nth-child(${label === 'Duplicate' ? 2 : 1})`);
    await dashboardOnly();
    await until(async () => label === 'Duplicate' ? (await get()).shows.length === 2 : Boolean((await get()).shows[0].pinnedAt) === (label === 'Pin to top'));
    if (label !== 'Duplicate') await realClick('[aria-label="Show actions for Cue modes"]');
  }
  await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Emulation.setDeviceMetricsOverride',
    params: {width: 1000, height: 900, deviceScaleFactor: 1, mobile: false}});
  await realClick('article:first-of-type button[aria-haspopup="menu"]');
  const overlap = await run(`
    const menu=document.querySelector('[role="menu"]'),button=menu.lastElementChild;
    const card=menu.closest('article'),next=card.nextElementSibling;
    const box=button.getBoundingClientRect(),other=next.getBoundingClientRect();
    const x=Math.round(box.left+box.width/2),y=Math.floor(box.bottom-3);
    return {x,y,overNext:x>other.left&&x<other.right&&y>other.top&&y<other.bottom,
      hitsDelete:button.contains(document.elementFromPoint(x,y))};
  `);
  assert.equal(overlap.overNext, true, 'Delete must overlap the following show card at the tested point');
  assert.equal(overlap.hitsDelete, true, 'the open menu must paint above the following card link');
  for (const type of ['mousePressed', 'mouseReleased']) {
    await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Input.dispatchMouseEvent',
      params: {type, x: overlap.x, y: overlap.y, button: 'left', clickCount: 1}});
  }
  await dashboardOnly();
  assert.match(await run('return document.body.innerText'), /Permanently delete Show/);
  await click('Cancel');
  await dashboardOnly();
  assert.equal((await get()).shows.length, 2, 'cancelling the overlapping Delete action preserves both shows');
  await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Emulation.clearDeviceMetricsOverride', params: {}});
  await realClick('[aria-label="Show actions for Cue modes (Copy)"]');
  await realClick('[role="menuitem"]:last-child');
  await dashboardOnly();
  assert.match(await run('return document.body.innerText'), /Permanently delete Show/);
  await click('Cancel');
  await realClick('[aria-label="Show actions for Cue modes (Copy)"]');
  await realClick('[role="menuitem"]:last-child');
  await click('Delete Show');
  await until(async () => (await get()).shows.length === 1);
  await dashboardOnly();
  await realClick('article a');
  await until(() => run(`return !!document.querySelector('[aria-label="Timer panel"]')`));
  await apiAction(base, 'configure', '2468');
  await until(() => run(`return !!document.querySelector('[aria-label="Unlock Show"]')`));
  // Simultaneous first authorizations share one cookie, even without Web Locks
  // (the IndexedDB mutex is also available on non-HTTPS local networks).
  const delayBootstrap = hold => run(`
    Object.defineProperty(navigator,'locks',{value:undefined,configurable:true});
    window.bootstrapCount=0;window.holdBootstrap=${hold};
    const beforeBootstrap=window.fetch;
    window.fetch=(...args)=>{
      if(args[1]?.method==='POST'&&JSON.parse(args[1].body||'{}').action==='bootstrap'){
        window.bootstrapCount++;
        if(window.holdBootstrap)return new Promise(resolve=>{window.releaseBootstrap=()=>{window.holdBootstrap=false;resolve(beforeBootstrap(...args))}});
      }
      return beforeBootstrap(...args);
    };
  `);
  await delayBootstrap(true);
  await run(`document.querySelector('[aria-label="Unlock Show"]').click()`);
  await field('[role="dialog"] input[type="password"]', '2468');
  await click('Unlock Show');
  await until(() => run(`return typeof window.releaseBootstrap==='function'`));
  await command('POST', `${prefix}/window`, {handle: viewer.handle});
  await navigate('#/control/modes');
  await until(() => run(`return !!document.querySelector('[aria-label="Unlock Show"]')`));
  await delayBootstrap(false);
  await run(`document.querySelector('[aria-label="Unlock Show"]').click()`);
  await field('[role="dialog"] input[type="password"]', '2468');
  await click('Unlock Show');
  await wait(200);
  assert.equal(await run('return window.bootstrapCount'), 0, 'a second document must wait for initial cookie establishment');
  await command('POST', `${prefix}/window`, {handle: control});
  await run('window.releaseBootstrap()');
  await until(() => run(`return !!document.querySelector('[aria-label="Lock Show"]')`));
  await command('POST', `${prefix}/window`, {handle: viewer.handle});
  await until(() => run(`return !!document.querySelector('[aria-label="Lock Show"]')`));
  await command('DELETE', `${prefix}/window`);
  await command('POST', `${prefix}/window`, {handle: control});
  await run(`document.querySelector('[aria-label="Lock Show"]').click()`);
  await until(() => run(`return !!document.querySelector('[aria-label="Unlock Show"]')`));
  await click('← All Shows');
  await noDashboardPinRow();
  assert.equal(await run(`return document.querySelector('button[aria-label^="Edit title"]').disabled&&[...document.querySelectorAll('button')].find(b=>b.textContent==='Settings').disabled`), true);
  assert.match(await run('return document.body.innerText'), /Open a show and select Unlock Show/);
  await run(`document.querySelector('[aria-label="Show actions for Cue modes"]').click()`);
  assert.equal(await run(`return [...document.querySelectorAll('[role="menuitem"]')].every(b=>b.disabled)`), true);
  assert.equal(await run(`return Array.from(document.querySelectorAll('[role="menuitem"]')).find(b=>b.textContent==='Delete').disabled`), true);
  await run(`document.querySelector('[aria-label="Open Cue modes"]').click()`);
  await run(`document.querySelector('[aria-label="Unlock Show"]').click()`);
  await field('[role="dialog"] input[type="password"]', '2468');
  await click('Unlock Show');
  await until(() => run(`return !!document.querySelector('[aria-label="Lock Show"]')`));
  await click('← All Shows');
  await run(`document.querySelector('[aria-label="Show actions for Cue modes"]').click()`);
  await click('Delete');
  assert.match(await run('return document.body.innerText'), /Permanently delete Show/);
  await click('Cancel');
  assert.equal((await get()).shows.length, 1);
  await run(`document.querySelector('[aria-label="Show actions for Cue modes"]').click()`);
  await click('Delete');
  await click('Delete Show');
  await until(async () => (await get()).shows.length === 0);
  await command('POST', `${prefix}/refresh`, {});
  await until(() => run(`return document.body.innerText.includes('Shows at a glance')`));
  await click('Add Show');
  assert.equal(await run(`return Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Create Show').disabled`), true);
  assert.doesNotMatch(await run('return document.body.innerText'), /select Unlock this window/);
  await field('[role="dialog"] input', 'Recovered empty installation');
  await click('Authorize to add shows');
  await field('[role="dialog"] input[type="password"]', '2468');
  await click('Unlock Show');
  await until(() => run(`return document.querySelector('[role="dialog"] input')?.value==='Recovered empty installation'`));
  await click('Create Show');
  await until(async () => (await get()).shows.some(show => show.title === 'Recovered empty installation'));
  await apiAction(base, 'configure', '');
  assert.deepEqual(await run('return window.browserErrors'), []);
}
test('browser timer controls, conflict recovery and read-only displays synchronize through PHP', { skip: !enabled }, async t => {
  const driver = process.env.CHROMEDRIVER_URL;
  const base = process.env.BROWSER_TEST_URL;
  const profile = path.resolve('.browser-data/profile');
  mkdirSync(profile, { recursive: true });
  async function command(method, endpoint, data) {
    const response = await fetch(`${driver}${endpoint}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result.value;
  }
  const session = await command('POST', '/session', { capabilities: { alwaysMatch: {
    browserName: 'chrome', 'goog:chromeOptions': { args: [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      `--user-data-dir=${profile}`, `--disk-cache-dir=${profile}/cache`,
    ] },
  } } });
  const prefix = `/session/${session.sessionId}`;
  t.after(() => command('DELETE', prefix));
  const run = script => command('POST', `${prefix}/execute/sync`, { script, args: [] });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const navigate = hash => command('POST', `${prefix}/url`, { url: `${base}/${hash}` });
  const get = () => fetch(`${base}/api.php`).then(response => response.json());
  const save = async data => {
    const response = await fetch(`${base}/api.php`, { method: 'PUT',
      headers: apiHeaders(base), body: JSON.stringify(data) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const instrument = () => command('POST', `${prefix}/goog/cdp/execute`, {
    cmd: 'Page.addScriptToEvaluateOnNewDocument', params: { source: `
      window.requests = []; window.browserErrors = [];
      window.activeRequests = 0; window.maxActiveRequests = 0;
      window.requestDelay = 0;
      window.addEventListener('error', event => window.browserErrors.push(event.message));
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const request = {url: String(args[0]), method: args[1]?.method || 'GET', body: args[1]?.body, start: Date.now()};
        window.requests.push(request);
        window.activeRequests++;
        window.maxActiveRequests = Math.max(window.maxActiveRequests, window.activeRequests);
        try {
          if (window.requestDelay) await new Promise(resolve => setTimeout(resolve, window.requestDelay));
          const response = await originalFetch(...args);
          request.status = response.status;
          return response;
        } finally {
          request.end = Date.now();
          window.activeRequests--;
        }
      };
    ` },
  });
  await instrument();
  await navigate('#/dsm/browser-test');
  await wait(1300);
  assertState(await get(), { initialized: false, revision: 0 });
  assert.ok((await run('return window.requests')).length >= 3);
  assert.ok((await run('return window.requests')).every(request => request.method === 'GET'),
    'a fresh DSM link must not initialize an empty store');
  for (const view of ['chroma', 'dsm-preview']) {
    await navigate(`#/${view}/browser-test`);
    await wait(900);
    assertState(await get(), {initialized: false, revision: 0});
    assert.ok((await run('return window.requests')).every(request => request.method === 'GET'),
      `a fresh ${view} link must not initialize an empty store`);
  }
  await navigate('#/display/browser-test');
  await wait(2200);
  assertState(await get(), { initialized: false, revision: 0 });
  assert.ok((await run('return window.requests')).length >= 5);
  assert.ok((await run('return window.requests')).every(request => request.method === 'GET'));
  await run('window.requestDelay=700; window.maxActiveRequests=window.activeRequests');
  await wait(2300);
  assert.equal(await run('return window.maxActiveRequests'), 1,
    'slow requests must not overlap faster polling intervals');
  const slowReads = await run('return window.requests.filter(r => r.end && r.end-r.start >= 650)');
  assert.ok(slowReads.length >= 2);
  assert.ok(slowReads[1].start - slowReads[0].end >= 200,
    'slow servers get a quiet polling interval after each completed request');
  await run('window.requestDelay=0');
  await save({ revision: 0, settings: { pin: '' }, timerCommands: ['browser-test'],
    shows: [{ id: 'browser-test', title: 'Browser polling test', active: 'cue', left: 30, status: 'Ready',
      cues: [{ id: 'cue', name: 'Browser cue', duration: 30 }], templateId: 'bayer-blue', logoOn: true }] });
  await wait(1300);
  assert.match(await run('return document.body.innerText'), /Browser polling test/);
  assert.ok((await run('return window.requests')).every(request => request.method === 'GET'));
  const display = await command('GET', `${prefix}/window`);
  const control = await command('POST', `${prefix}/window/new`, { type: 'tab' });
  await command('POST', `${prefix}/window`, { handle: control.handle });
  await instrument();
  await navigate('#/control/browser-test');
  await wait(600);
  const until = async (predicate, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, 'timed out waiting for browser save');
      await wait(40);
    }
  };
  await run('window.requestDelay=700; window.requests=[]; window.maxActiveRequests=window.activeRequests');
  await until(() => run('return window.requests.some(r=>r.method==="GET" && !r.end)'));
  const editedAt = Date.now();
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Start').click()`);
  await until(() => run('return window.requests.some(r=>r.method==="PUT")'), 1300);
  const firstPut = await run('return window.requests.find(r=>r.method==="PUT")');
  assert.ok(firstPut.start - editedAt < 1100, 'a pending edit must beat the next poll after a slow GET');
  t.diagnostic(`700ms GET/PUT latency: first PUT started ${firstPut.start - editedAt}ms after edit`);
  // Queue another local edit and a disjoint remote edit during the delayed PUT.
  await run(`document.querySelector('[aria-label="Logo on display"]').click()`);
  const concurrentMetadata = await get();
  await save({ ...concurrentMetadata, timerCommands: [],
    shows: concurrentMetadata.shows.map(show => ({ ...show, title: 'Disjoint remote title' })) });
  await until(async () => {
    const state = await get();
    return state.shows[0].status === 'Running' && state.shows[0].logoOn === false;
  });
  assert.equal((await get()).shows[0].status, 'Running');
  assert.equal((await get()).shows[0].title, 'Disjoint remote title');
  assert.ok(await run('return window.requests.some(r=>r.method==="PUT" && r.status===409)'),
    'disjoint edits must recover from a real stale-revision response');
  assert.equal(await run('return window.maxActiveRequests'), 1);
  assert.doesNotMatch(await run('return document.body.innerText'), /Changes not saved|Concurrent edits|Timer controls were edited/);
  await run('window.requestDelay=0');
  const started = await get();
  await wait(1500);
  assert.equal((await get()).revision, started.revision);
  assert.ok((await get()).shows[0].left < started.shows[0].left);
  // Also cover latency above the old 50ms debounce/poll gap, but below 250ms.
  await run(`window.requestDelay=120; document.querySelector('[aria-label="Logo on display"]').click()`);
  await until(async () => (await get()).shows[0].logoOn === true, 1800);
  await run(`document.querySelector('[aria-label="Logo on display"]').click()`);
  await until(async () => (await get()).shows[0].logoOn === false, 1800);
  await run('window.requestDelay=0');
  assert.equal((await get()).shows[0].logoOn, false);
  const click = windowClicks(command, prefix, run, text => run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`), instrument);
  const clickLabel = label => run(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`);
  const fillPassword = async (index, value) => {
    await run(`{
      const input = document.querySelectorAll('[role="dialog"] input[type="password"]')[${index}];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', {bubbles:true}));
    }`);
  };
  const fillRemaining = async (minutes, seconds) => {
    for (const [label, value] of [['Remaining minutes', minutes], ['Remaining seconds', seconds]]) {
      await run(`{
        const input = document.querySelector('[aria-label="${label}"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', {bubbles:true}));
      }`);
    }
  };
  const saveDisabled = () => run(`return Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Save & start').disabled`);
  await click('Set remaining time');
  const beforeInvalid = await get();
  for (const [minutes, seconds] of [['-1','0'], ['1.5','0'], ['NaN','0'], ['0','60'],
    ['0','-1'], ['0','1.5'], ['0','0'], ['', '1'], ['1e2','0'], ['150119987579016','32']]) {
    await fillRemaining(minutes, seconds);
    assert.equal(await saveDisabled(), true, `${minutes}:${seconds} must not save`);
  }
  await click('Cancel');
  assert.equal((await get()).revision, beforeInvalid.revision);
  await click('Set remaining time');
  await fillRemaining('2', '5');
  await wait(1100); // Ordinary ticks while editing are not conflicts.
  await click('Save & start');
  await until(async () => (await get()).shows[0].left > 120);
  const replacement = await get();
  assert.equal(replacement.shows[0].status, 'Running');
  assert.equal(replacement.shows[0].cues[0].duration, 30);
  assert.deepEqual(JSON.parse(await run(`return window.requests.filter(r=>r.method==='PUT').at(-1).body`)).timerCommands, ['browser-test']);
  await command('POST', `${prefix}/window`, { handle: display });
  await until(() => run(`return document.body.innerText.includes('2:0')`));
  assert.equal(await run(`return Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Set remaining time'))`), false);
  assert.ok((await run('return window.requests')).every(request => request.method === 'GET'));
  await command('POST', `${prefix}/window`, { handle: control.handle });
  const peer = await command('POST', `${prefix}/window/new`, { type: 'tab' });
  await command('POST', `${prefix}/window`, { handle: peer.handle });
  await navigate('#/control/browser-test');
  await until(() => run(`return document.body.innerText.includes('2:0')`));
  await command('POST', `${prefix}/window`, { handle: control.handle });
  const mutate = async fields => {
    const state = await get();
    return save({ ...state, timerCommands: ['browser-test'],
      shows: state.shows.map(show => ({ ...show, ...fields })) });
  };
  // All non-running states immediately become running, without editing cue duration.
  for (const status of ['Ready', 'Paused', 'Complete']) {
    await mutate({status, left: 0});
    await until(() => run(`return document.body.innerText.includes(${JSON.stringify(status)})`));
    await click('Set remaining time');
    await fillRemaining('0', '45');
    await click('Save & start');
    await until(async () => (await get()).shows[0].status === 'Running');
    assert.ok((await get()).shows[0].left >= 44);
    assert.equal((await get()).shows[0].cues[0].duration, 30);
  }
  const sameValue = await mutate({status: 'Running', left: 200});
  await until(() => run(`return document.body.innerText.includes('3:20')`));
  await click('Set remaining time');
  // Save the prefilled, unchanged value: no runtime diff, but still an intentional restart.
  await click('Save & start');
  await until(async () => (await get()).revision > sameValue.revision);
  const sameRestart = await get();
  assert.ok(sameRestart.timerVersions['browser-test'][3] > sameValue.timerVersions['browser-test'][3]);
  assert.equal(sameRestart.timerVersions['browser-test'][1], 200);
  await click('Reset');
  await until(async () => (await get()).shows[0].status === 'Ready');
  assert.equal((await get()).shows[0].left, 30, 'Reset must use the original cue duration');

  // A changed/deleted active cue or a genuine remote timer command invalidates an open draft.
  const originalCue = (await get()).shows[0].cues[0];
  for (const fields of [
    {cues: [{...originalCue, duration: 60}]},
    {cues: []},
    {active: 'other', cues: [originalCue, {...originalCue, id: 'other'}]},
    {left: 80, status: 'Running'},
  ]) {
    await click('Set remaining time');
    await fillRemaining('1', '5');
    await mutate(fields);
    await until(saveDisabled);
    assert.match(await run('return document.body.innerText'), /active cue or timer changed/);
    await click('Cancel');
    const restored = await mutate({active: 'cue', cues: [originalCue], status: 'Ready', left: 30});
    await until(() => run(`return document.body.innerText.includes('Ready') && document.body.innerText.includes('0:30')`));
    await wait(300);
    assert.equal((await get()).revision, restored.revision);
  }
  await mutate({active: 'missing'});
  await until(() => run(`return Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Set remaining time').disabled`));
  await mutate({active: 'cue'});
  await until(() => run(`return !Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Set remaining time').disabled`));
  const beforeDeletion = await get();
  await click('Set remaining time');
  await save({...beforeDeletion, shows: [], timerCommands: []});
  await until(() => run(`return document.body.innerText.includes('Show not found')`));
  assert.equal(await run(`return Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Save & start')`), false);
  await save({...beforeDeletion, revision: (await get()).revision, timerCommands: ['browser-test']});
  await until(() => run(`return document.body.innerText.includes('Set remaining time')`));
  // The workspace header owns both actions; the sidebar has no duplicate controls.
  assert.equal(await run(`return document.querySelector('[aria-label="Set Show PIN"]').closest('[aria-label="Timer panel"]') !== null`), true);
  assert.equal(await run(`return document.querySelectorAll('aside [aria-label="Show controls"]').length`), 0);
  await clickLabel('Set Show PIN');
  await fillPassword(0, '1234');
  await fillPassword(1, '1234');
  await click('Save PIN');
  await until(async () => (await get()).auth.configured);
  assert.equal((await get()).settings.pin, '');
  await until(() => run(`return !!document.querySelector('[aria-label="Lock Show"]')`));
  await command('POST', `${prefix}/window`, {handle: peer.handle});
  await until(() => run(`return !!document.querySelector('[aria-label="Unlock Show"]')`));
  assert.equal(await run(`return Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Set remaining time').disabled`), true);
  await clickLabel('Unlock Show');
  await fillPassword(0, '1234');
  await click('Unlock Show');
  await until(() => run(`return !!document.querySelector('[aria-label="Lock Show"]')`));
  await command('POST', `${prefix}/window`, {handle: control.handle});
  await click('Set remaining time');
  await fillRemaining('1', '10');
  await clickLabel('Lock Show');
  await until(() => run(`return !!document.querySelector('[aria-label="Unlock Show"]')`));
  assert.equal(await saveDisabled(), true, 'locking with an open draft must prevent saving');
  await command('POST', `${prefix}/window`, {handle: peer.handle});
  assert.equal(await run(`return Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Set remaining time').disabled`), false, 'relocking one window must not lock the other');
  await command('DELETE', `${prefix}/window`);
  await command('POST', `${prefix}/window`, {handle: control.handle});
  await click('Cancel');
  assert.equal(await run(`return Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Set remaining time').disabled`), true);
  assert.equal(await run(`return document.querySelector('[aria-label="Blackout"]').disabled`), true);
  assert.equal(await run(`return document.querySelector('[aria-label="Unlock Show"]').getAttribute('aria-pressed')`), 'true');
  for (const output of ['Preview display', 'Open DSM', 'Open Chroma mode']) {
    await click(output);
    assert.equal(await run(`return !!document.querySelector('[role="dialog"]')`), false, 'public viewing never requires a PIN');
    await click('Back to Show');
    assert.equal(await run(`return !!document.querySelector('[aria-label="Unlock Show"]')`), true, 'viewing does not authorize the operator');
  }
  await clickLabel('Unlock Show');
  await fillPassword(0, '0000');
  await click('Unlock Show');
  await until(() => run(`return document.body.innerText.includes('PIN is not correct')`));
  assert.match(await run('return document.body.innerText'), /PIN is not correct/);
  await fillPassword(0, '1234');
  await click('Unlock Show');
  await until(() => run(`return !!document.querySelector('[aria-label="Lock Show"]')`));
  assert.equal(await run(`return document.querySelector('[aria-label="Lock Show"]').getAttribute('aria-pressed')`), 'false');
  // Change directly without opening an unprotected remove/reconfigure interval.
  await click('Change or remove PIN');
  await fillPassword(0, '1234');
  await fillPassword(1, '4321');
  await fillPassword(2, '4321');
  await click('Change PIN');
  await until(() => run(`return !document.querySelector('[role="dialog"]')`));
  assert.equal((await get()).auth.configured, true);
  await until(() => run(`return !!document.querySelector('[aria-label="Lock Show"]')`));
  // PIN management remains reachable, including removing and configuring a new PIN.
  await click('Change or remove PIN');
  await fillPassword(0, '0000');
  await click('Remove PIN / Disable Lock');
  await until(() => run(`return document.body.innerText.includes('PIN is not correct')`));
  assert.match(await run('return document.body.innerText'), /PIN is not correct/);
  await fillPassword(0, '4321');
  await click('Remove PIN / Disable Lock');
  await until(async () => !(await get()).auth.configured);
  await click('Configure PIN lock');
  await fillPassword(0, '5678');
  await fillPassword(1, '5678');
  await click('Save PIN');
  await until(async () => (await get()).auth.configured);
  await until(() => run(`return !!document.querySelector('[aria-label="Lock Show"]')`));
  await apiAction(base, 'unlock', '5678');
  await click('Start');
  await until(async () => (await get()).shows[0].status === 'Running');
  const beforeBlackout = await get();
  await clickLabel('Blackout');
  assert.match(await run('return document.querySelector("[role=dialog]").innerText'), /Enable blackout\?/);
  assert.equal(Boolean((await get()).shows[0].blackout), false, 'opening confirmation must not enable blackout');
  await click('Cancel');
  assert.equal((await get()).revision, beforeBlackout.revision, 'cancel must not save');
  await clickLabel('Blackout');
  await click('Enable Blackout');
  await until(async () => (await get()).shows[0].blackout === true);
  assert.equal(await run(`return document.querySelector('[aria-label="Clear blackout"]').getAttribute('aria-pressed')`), 'true');
  assert.match(await run(`return document.querySelector('[aria-label="Timer panel"]').innerText`), /BLACKOUT ACTIVE.*Timers continue running/);
  const blackoutTimer = await get();
  await wait(1300);
  assert.equal((await get()).revision, blackoutTimer.revision);
  assert.ok((await get()).shows[0].left < blackoutTimer.shows[0].left, 'blackout must not stop the timer');
  await clickLabel('Lock Show');
  assert.equal(await run(`return document.querySelector('[aria-label="Clear blackout"]').disabled`), true);
  await clickLabel('Unlock Show');
  await fillPassword(0, '5678');
  await click('Unlock Show');
  await until(() => run(`return !!document.querySelector('[aria-label="Lock Show"]')`));
  // Keep the icon buttons top-right, visible and nonoverlapping on phones in either theme.
  for (const [width, theme] of [[320, 'light'], [320, 'dark'], [360, 'light'], [360, 'dark']]) {
    await command('POST', `${prefix}/goog/cdp/execute`, {
      cmd: 'Emulation.setDeviceMetricsOverride',
      params: {width, height: 800, deviceScaleFactor: 1, mobile: false},
    });
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; window.scrollTo(0,0)`);
    assert.equal(await run('return window.innerWidth'), width);
    assert.equal(await run(`{
      const panel = document.querySelector('[aria-label="Timer panel"]').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('[aria-label="Show controls"] button')];
      const [lock, blackout] = buttons.map(b=>b.getBoundingClientRect());
      return lock.width >= 44 && blackout.width >= 44 && lock.right <= blackout.left &&
        lock.top === blackout.top && blackout.right <= panel.right &&
        blackout.right <= window.innerWidth && lock.top < panel.top + 50 &&
        buttons.every(b=>b.title === b.getAttribute('aria-label'));
    }`), true, `${width}px ${theme} header controls must remain accessible at top-right`);
  }
  await clickLabel('Clear blackout');
  await until(async () => (await get()).shows[0].blackout === false);
  assert.equal(await run(`return document.querySelector('[aria-label="Blackout"]').getAttribute('aria-pressed')`), 'false');
  await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Emulation.clearDeviceMetricsOverride', params: {}});
  await run(`document.documentElement.dataset.theme='light'`);
  await clickLabel('Lock Show');
  // Reload starts a fresh, independently locked operator window.
  await command('POST', `${prefix}/refresh`, {});
  await until(() => run(`return document.body.innerText.includes('Set remaining time')`));
  await until(() => run(`return !!document.querySelector('[aria-label="Unlock Show"]')`));
  await clickLabel('Unlock Show');
  await fillPassword(0, '5678');
  await click('Unlock Show');
  await until(() => run(`return !!document.querySelector('[aria-label="Lock Show"]')`));

  // Preserve a second command queued while the first command is in flight.
  await run(`{
    const original = window.fetch;
    window.fetch = (...args) => args[1]?.method === 'PUT' && window.holdPut
      ? new Promise(resolve => { window.releasePut = () => {window.holdPut=false; resolve(original(...args));}; })
      : original(...args);
    window.holdPut=true;
  }`);
  await click('Set remaining time');
  await fillRemaining('0', '51');
  await click('Save & start');
  await until(() => run('return typeof window.releasePut==="function"'));
  await click('Set remaining time');
  await fillRemaining('0', '52');
  await click('Save & start');
  await run('window.releasePut()');
  await until(async () => (await get()).timerVersions['browser-test'][1] === 52);
  assert.doesNotMatch(await run('return document.body.innerText'), /Changes not saved|Timer controls were edited/);

  // A stale PUT must not silently overwrite a competing timer restart.
  await run('window.holdPut=true; window.releasePut=null');
  await click('Set remaining time');
  await fillRemaining('0', '53');
  await click('Save & start');
  await until(() => run('return typeof window.releasePut==="function"'));
  const competing = await mutate({left: 54, status: 'Running'});
  await run('window.releasePut()');
  await until(() => run(`return document.body.innerText.includes('Timer controls were edited')`));
  assert.equal((await get()).revision, competing.revision);
  assert.equal((await get()).timerVersions['browser-test'][1], 54);
  await run('window.onbeforeunload=null'); // CDP reload bypasses the pending-edits prompt.
  await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Page.reload', params: {}});
  await until(() => run(`return document.body.innerText.includes('Set remaining time') && !document.body.innerText.includes('Changes not saved')`));
  await apiAction(base, 'configure', '');
  await until(() => run(`return !!document.querySelector('[aria-label="Set Show PIN"]')`));
  await click('Preview display');
  await wait(100);
  await run(`window.requests=[]`);
  await wait(1800);
  assert.match(await run('return document.body.innerText'), /Read-only display preview/);
  assert.ok((await run('return window.requests')).every(request => request.method === 'GET'));
  assert.doesNotMatch(await run('return document.body.innerText'), /Changes not saved/);
  const remote = await get();
  await save({ ...remote, timerCommands: [],
    shows: remote.shows.map(show => ({ ...show, title: 'Updated from another device' })) });
  await wait(1300);
  assert.match(await run('return document.body.innerText'), /Updated from another device/);
  await command('POST', `${prefix}/window`, { handle: display });
  assert.match(await run('return document.body.innerText'), /Updated from another device/);
  assert.ok((await run('return window.requests')).every(request => request.method === 'GET'));
  assert.deepEqual(await run('return window.browserErrors'), []);
  await command('POST', `${prefix}/window`, { handle: control.handle });
  await click('Back to Show');
  await wait(100);

  // Capture real PNG pixels with the browser canvas background omitted. Computed
  // transparency alone misses opaque ancestor/fullscreen canvas backgrounds.
  const cdp = (cmd, params = {}) => command('POST', `${prefix}/goog/cdp/execute`, {cmd, params});
  const realClick = async selector => {
    const element = await command('POST', `${prefix}/element`, {using: 'css selector', value: selector});
    await command('POST', `${prefix}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
  };
  const key = value => command('POST', `${prefix}/actions`, {actions: [{
    type: 'key', id: 'keyboard', actions: [{type: 'keyDown', value}, {type: 'keyUp', value}],
  }]});
  const move = (x, y) => cdp('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
  const visible = () => run(`return getComputedStyle(document.querySelector('.presentation-buttons')).opacity`);
  const cornerControls = async (exitLabel, digits = true) => {
    await run('document.activeElement.blur()');
    await move(100, 150);
    assert.equal(await visible(), '0', 'movement away must not reveal controls');
    await move(200, 200);
    assert.equal(await visible(), '0');
    const point = await run(`const r=document.querySelector('.presentation-buttons button').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}`);
    await move(point.x, point.y);
    assert.equal(await visible(), '1', 'hovering the corner reveals buttons');
    await wait(3300);
    assert.equal(await visible(), '1', 'hovering a button must not time out');
    await move(await run('return innerWidth-2'), 2);
    assert.equal(await visible(), '1', 'corner padding remains a discoverable hotzone');
    await move(100, 150);
    assert.equal(await visible(), '0', 'leaving the corner hides controls');
    await key('\uE004'); // Tab must reach buttons even while visually hidden.
    assert.equal(await run(`return document.activeElement.closest('.presentation-buttons') !== null`), true);
    assert.equal(await visible(), '1', 'keyboard focus exposes controls');
    if (digits) {
      await key('\uE007'); // Enter activates the focused digit control.
      assert.equal(await run(`return !!document.querySelector('[aria-label="Switch timer digits to white"]')`), true);
      await key('\uE007');
      await key('\uE004');
      assert.equal(await run('return document.activeElement.getAttribute("aria-label")'), exitLabel);
    }
    await move(200, 200);
    assert.equal(await visible(), '1', 'focus-within survives movement elsewhere');
    await run('document.activeElement.blur()');
    assert.equal(await visible(), '0');
    await cdp('Emulation.setTouchEmulationEnabled', {enabled: true});
    const tap = async (x, y) => {
      await cdp('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
      await cdp('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
      await wait(100);
    };
    // Tap directly over the hidden action: the first tap must only reveal.
    await tap(point.x, point.y);
    assert.equal(await visible(), '1');
    assert.equal(await run(`return !!document.querySelector('[aria-label="${exitLabel}"]')`), true);
    if (digits) {
      assert.equal(await run(`return !!document.querySelector('[aria-label="Switch timer digits to black"]')`), true);
      await tap(point.x, point.y);
      assert.equal(await run(`return !!document.querySelector('[aria-label="Switch timer digits to white"]')`), true);
      await tap(point.x, point.y);
    }
    await tap(100, 150);
    assert.equal(await visible(), '0', 'outside touch dismisses even after a focused action');
    await cdp('Emulation.setTouchEmulationEnabled', {enabled: false});
  };
  await cdp('Emulation.setDefaultBackgroundColorOverride', {color: {r: 0, g: 0, b: 0, a: 0}});
  const pixels = async () => {
    const {data} = await cdp('Page.captureScreenshot', {format: 'png'});
    return command('POST', `${prefix}/execute/async`, {args: [data], script: `
      const done = arguments[arguments.length - 1];
      const image = new Image();
      image.onerror = () => done({error: 'Cannot decode captured PNG'});
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d', {willReadFrequently: true});
        ctx.drawImage(image, 0, 0);
        const corner = Array.from(ctx.getImageData(20, 20, 1, 1).data);
        const hotzone = Array.from(ctx.getImageData(image.width-30, 30, 1, 1).data);
        const center = Array.from(ctx.getImageData(Math.floor(image.width/2), Math.floor(image.height/2), 1, 1).data);
        const digits = document.querySelector('[aria-label="DSM output"] > span');
        const colors = {white: 0, black: 0};
        if (digits) {
          const rect = digits.getBoundingClientRect();
          const scale = image.width / window.innerWidth;
          const rgba = ctx.getImageData(Math.floor(rect.x*scale), Math.floor(rect.y*scale),
            Math.ceil(rect.width*scale), Math.ceil(rect.height*scale)).data;
          for (let i=0; i<rgba.length; i+=4) {
            if (rgba[i+3] !== 255) continue;
            if (rgba[i]===255 && rgba[i+1]===255 && rgba[i+2]===255) colors.white++;
            if (rgba[i]===0 && rgba[i+1]===0 && rgba[i+2]===0) colors.black++;
          }
        }
        done({corner, hotzone, center, colors});
      };
      image.src = 'data:image/png;base64,' + arguments[0];
    `});
  };
  const assertAlpha = async (color = 'white') => {
    const captured = await pixels();
    assert.equal(captured.corner[3], 0, 'captured corner must have zero alpha');
    assert.equal(captured.hotzone[3], 0, 'hidden control hotzone must preserve alpha');
    assert.equal(captured.center[3], 0, 'captured center must have zero alpha');
    assert.ok(captured.colors[color] > 20, `captured ${color} digits must remain opaque and visible`);
    const backgrounds = await run(`return [
      document.documentElement, document.body, document.getElementById('root'),
      document.querySelector('main'), document.querySelector('[aria-label="DSM output"]')
    ].map(node => [getComputedStyle(node).backgroundColor, getComputedStyle(node).backgroundImage])`);
    assert.ok(backgrounds.every(([color, image]) => color === 'rgba(0, 0, 0, 0)' && image === 'none'),
      'every output ancestor must be transparent without a checkerboard');
    assert.doesNotMatch(await run('return document.body.innerText'), /mock preview|DSM presentation preview/i);
    assert.equal(await run(`return !!document.querySelector('input[type="checkbox"]')`), false);
  };
  await click('Open DSM');
  await cdp('Emulation.setDefaultBackgroundColorOverride', {color: {r: 0, g: 0, b: 0, a: 0}});
  assert.doesNotMatch(await run('return document.body.innerText'), /mock preview/i);
  const outputUrl = await run(`return document.querySelector('[aria-label="DSM output URL address"]').value`);
  assert.equal(new URL(outputUrl).hash, '#/dsm/browser-test');
  // Use an actual user click to exercise the native fullscreen backdrop as well.
  const expand = await command('POST', `${prefix}/element`, {
    using: 'css selector', value: '[aria-label="Expand DSM display"]',
  });
  await command('POST', `${prefix}/element/${expand['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
  await until(() => run(`return !!document.fullscreenElement && !!document.querySelector('[aria-label="DSM output"]')`));
  await wait(300);
  await assertAlpha();
  await cornerControls('Exit DSM presentation');
  await key('\uE00C'); // Escape exits both presentation and native fullscreen.
  await until(() => run(`return !document.fullscreenElement && !document.documentElement.hasAttribute('data-dsm-output')`));
  assert.equal((await pixels()).corner[3], 255, 'exiting fullscreen restores the normal page canvas');
  await click('Back to Show');
  await run(`document.querySelector('[aria-label="Dark mode"]').click()`);
  await until(() => run(`return document.documentElement.dataset.theme === 'dark'`));
  await navigate('#/dsm/browser-test');
  await until(() => run(`return !!document.querySelector('[aria-label="DSM output"]')`));
  await assertAlpha();
  // Refresh the clean source URL: it must stay clean and read-only.
  await command('POST', `${prefix}/refresh`, {});
  await until(() => run(`return !!document.querySelector('[aria-label="DSM output"]')`));
  assert.equal(await run('return location.hash'), '#/dsm/browser-test');
  await assertAlpha();
  await run(`document.querySelector('[aria-label="Switch timer digits to black"]').click()`);
  await assertAlpha('black');
  await run(`document.querySelector('[aria-label="Switch timer digits to white"]').click()`);
  await assertAlpha();
  // Theme changes cannot reintroduce an opaque canvas while output is active.
  for (const theme of ['light', 'dark']) {
    await run(`document.documentElement.dataset.theme = '${theme}'`);
    await assertAlpha();
  }
  await cornerControls('Exit DSM presentation');
  await run('window.requests=[]');
  const beforeDsmTicks = await get();
  await wait(1300);
  const afterDsmTicks = await get();
  assert.equal(afterDsmTicks.revision, beforeDsmTicks.revision);
  assert.ok(afterDsmTicks.shows[0].left < beforeDsmTicks.shows[0].left,
    'DSM follows the existing server clock without browser writes');
  assert.ok((await run('return window.requests')).length >= 3);
  assert.ok((await run('return window.requests')).every(request => request.method === 'GET'));
  await save({...afterDsmTicks, timerCommands: [],
    shows: afterDsmTicks.shows.map(show => ({...show, blackout: true}))});
  await until(() => run(`return !!document.querySelector('[aria-label="Blackout active"]')`));
  const blackedOut = await pixels();
  assert.deepEqual(blackedOut.corner, [0, 0, 0, 255]);
  assert.deepEqual(blackedOut.center, [0, 0, 0, 255]);
  await cornerControls('Exit blackout presentation', false);
  const duringBlackout = await get();
  await wait(1100);
  const afterBlackout = await get();
  assert.equal(afterBlackout.revision, duringBlackout.revision);
  assert.ok(afterBlackout.shows[0].left < duringBlackout.shows[0].left);
  await save({...afterBlackout, timerCommands: [],
    shows: afterBlackout.shows.map(show => ({...show, blackout: false}))});
  await until(() => run(`return !!document.querySelector('[aria-label="DSM output"]')`));
  await assertAlpha();
  await key('\uE00C'); // Clean DSM URLs must exit without native fullscreen too.
  assert.equal(await run(`return document.documentElement.hasAttribute('data-dsm-output')`), false);
  await click('Back to Show');
  assert.equal(await run(`return document.documentElement.dataset.theme`), 'dark');
  assert.equal(await run(`return getComputedStyle(document.documentElement).backgroundColor`), 'rgb(15, 23, 42)');
  assert.equal((await pixels()).corner[3], 255);
  await run(`document.querySelector('[aria-label="Dark mode"]').click()`);
  await until(() => run(`return document.documentElement.dataset.theme === 'light'`));
  assert.equal((await pixels()).corner[3], 255);
  // Hash navigation also cleans up the document override without a full reload.
  await run(`location.hash = '#/dsm/browser-test'`);
  await until(() => run(`return document.documentElement.hasAttribute('data-dsm-output')`));
  await run(`location.hash = '#/control/browser-test'`);
  await until(() => run(`return !!document.querySelector('[aria-label="Dark mode"]')`));
  assert.equal(await run(`return document.documentElement.hasAttribute('data-dsm-output')`), false);
  assert.equal((await pixels()).corner[3], 255);
  await cdp('Emulation.setDefaultBackgroundColorOverride');
  // Chroma uses the same corner interactions and exits native fullscreen.
  await click('Open Chroma mode');
  await realClick('[aria-label="Expand Chroma display"]');
  await until(() => run(`return !!document.fullscreenElement && !!document.querySelector('[aria-label="Exit Chroma presentation"]')`));
  await cornerControls('Exit Chroma presentation');
  assert.equal(await run(`return getComputedStyle(document.querySelector('main')).backgroundColor`), 'rgb(0, 200, 83)');
  const chromaState = await get();
  await save({...chromaState, timerCommands: [],
    shows: chromaState.shows.map(show => ({...show, blackout: true}))});
  await until(() => run(`return !!document.querySelector('[aria-label="Blackout active"]')`));
  assert.deepEqual((await pixels()).center, [0, 0, 0, 255], 'Chroma blackout must remain opaque');
  await cornerControls('Exit blackout presentation', false);
  // First touch over Exit only reveals; the second actually exits.
  await cdp('Emulation.setTouchEmulationEnabled', {enabled: true});
  const exitPoint = await run(`const r=document.querySelector('[aria-label="Exit blackout presentation"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}`);
  for (let tap = 0; tap < 2; tap++) {
    await cdp('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [exitPoint]});
    await cdp('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await wait(100);
    if (!tap) assert.equal(await visible(), '1');
  }
  await until(() => run(`return !document.fullscreenElement && !!document.querySelector('[aria-label="Dark mode"]')`));
  await cdp('Emulation.setTouchEmulationEnabled', {enabled: false});
  await click('Back to Show');
  const restoreChroma = await get();
  await save({...restoreChroma, timerCommands: [],
    shows: restoreChroma.shows.map(show => ({...show, blackout: false}))});
  await click('Open Chroma mode');
  await realClick('[aria-label="Expand Chroma display"]');
  await until(() => run(`return !!document.fullscreenElement && !!document.querySelector('[aria-label="Exit Chroma presentation"]')`));
  await key('\uE00C');
  await until(() => run(`return !document.fullscreenElement && !!document.querySelector('[aria-label="Dark mode"]')`));
  await click('Back to Show');
  // Native browser fullscreen exit still returns to the normal workspace.
  await click('Open Chroma mode');
  await realClick('[aria-label="Expand Chroma display"]');
  await until(() => run('return !!document.fullscreenElement'));
  await run('document.exitFullscreen()');
  await until(() => run(`return !!document.querySelector('[aria-label="Dark mode"]')`));
  await click('Back to Show');
  assert.deepEqual(await run('return window.browserErrors'), []);
  await run(`
    const beforeDelay = window.fetch;
    window.fetch = (...args) => args[1]?.method === 'PUT'
      ? new Promise(resolve => { window.releasePut = () => resolve(beforeDelay(...args)); })
      : beforeDelay(...args);
    document.querySelector('h2').parentElement.querySelector('button').click();
  `);
  await wait(100);
  await run(`
    const input = document.querySelector('input.text-slate-900');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Local conflicting title');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  `);
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Save').click()`);
  await wait(600);
  assert.equal(await run('return typeof window.releasePut'), 'function');
  const concurrent = await get();
  await save({ ...concurrent, timerCommands: [],
    shows: concurrent.shows.map(show => ({ ...show, title: 'Remote conflicting title' })) });
  await run('window.releasePut()');
  await wait(1200);
  assert.match(await run('return document.body.innerText'), /Concurrent edits overlap/);
  assert.match(await run('return document.body.innerText'), /Local conflicting title/);
  assert.equal((await get()).shows[0].title, 'Remote conflicting title');
  assert.deepEqual(await run('return window.browserErrors'), []);
});
test('browser continuous countdown bar follows samples without writes or blackout-off status', {skip: !enabled}, async t => {
  const driver = process.env.CHROMEDRIVER_URL, base = process.env.BROWSER_TEST_URL;
  const profile = path.resolve('.browser-data/urgency-profile');
  mkdirSync(profile, {recursive: true});
  const command = async (method, endpoint, data) => {
    const response = await fetch(`${driver}${endpoint}`, {method,
      headers: {'Content-Type': 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data)});
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result.value;
  };
  const session = await command('POST', '/session', {capabilities: {alwaysMatch: {
    browserName: 'chrome', 'goog:chromeOptions': {args: [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profile}`,
    ]},
  }}});
  const prefix = `/session/${session.sessionId}`;
  t.after(() => command('DELETE', prefix));
  const run = script => command('POST', `${prefix}/execute/sync`, {script, args: []});
  const cdp = (cmd, params) => command('POST', `${prefix}/goog/cdp/execute`, {cmd, params});
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => {
    const deadline = Date.now() + 6000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, 'countdown bar condition timed out');
      await wait(40);
    }
  };
  const get = () => fetch(`${base}/api.php`).then(response => response.json());
  const seed = {id: 'urgency', title: 'Continuous countdown', active: 'cue', left: 20, status: 'Running',
    cues: [{id: 'cue', name: 'Countdown', duration: 30}], templateId: 'bayer-blue', logoOn: false};
  const response = await fetch(`${base}/api.php`, {method: 'PUT', headers: apiHeaders(base),
    body: JSON.stringify({revision: (await get()).revision, shows: [seed], settings: {pin: ''}, timerCommands: ['urgency']})});
  assert.equal(response.status, 200);
  await cdp('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.requests=[];window.polls=0;window.heldSample=null;window.browserErrors=[];
    window.addEventListener('error',e=>window.browserErrors.push(e.message));
    const original=window.fetch;
    window.fetch=async(...args)=>{
      window.requests.push(args[1]?.method||'GET');
      const response=await original(...args);
      if((args[1]?.method||'GET')==='GET'&&String(args[0]).includes('api.php')){
        window.polls++;
        if(window.heldSample)return new Response(JSON.stringify(window.heldSample),{status:200,headers:{'Content-Type':'application/json'}});
      }
      return response;
    };
  `});
  await command('POST', `${prefix}/url`, {url: `${base}/#/control/urgency`});
  await until(() => run(`return !!document.querySelector('[aria-label="Timer panel"]')`));
  assert.doesNotMatch(await run('return document.body.innerText'), /Output live|blackout is off|BLACKOUT ACTIVE/);
  await run(`location.hash='#/display/urgency'`);
  await until(() => run(`return !!document.querySelector('[data-countdown-bar]')`));
  const revision = (await get()).revision;
  const edge = () => run(`return parseFloat(getComputedStyle(document.querySelector('[data-countdown-bar]')).clipPath.split(' ')[1])`);
  const samples = () => command('POST', `${prefix}/execute/async`, {args: [], script: `
    const done=arguments[arguments.length-1],values=[],start=performance.now();
    let previous=-100;
    function sample(now){
      if(now-previous>=90){
        const node=document.querySelector('[data-countdown-bar]');
        values.push({time:now,edge:parseFloat(getComputedStyle(node).clipPath.split(' ')[1])});
        previous=now;
      }
      if(now-start<950)requestAnimationFrame(sample);else done(values);
    }
    requestAnimationFrame(sample);
  `});
  const continuous = values => {
    assert.ok(values.length >= 9, 'multiple intermediate clip positions within one second');
    for (let i = 1; i < values.length; i++) {
      const delta = values[i].edge - values[i-1].edge;
      assert.ok(delta > 0, `bar must move continuously, never pause/reset between polls: ${JSON.stringify(values)}`);
      assert.ok(delta < (values[i].time-values[i-1].time)/1000*2.2, 'bounded continuous server corrections');
    }
  };
  continuous(await samples());
  assert.equal((await get()).revision, revision, 'visual frames never write revisions');
  assert.ok((await run('return window.requests')).every(method => method === 'GET'));
  // Freeze rounded API samples while real 250ms polling continues. Metadata polls
  // and repeated left values must not re-anchor the visual clock or cause sawtooth.
  const held = await get();
  await run(`window.heldSample=${JSON.stringify(held)}`);
  await until(() => run('return window.polls>=5'));
  const polls = await run('return window.polls');
  continuous(await samples());
  assert.ok(await run('return window.polls') >= polls + 3);
  const change = async patch => {
    const before = await run('return window.polls');
    await run(`Object.assign(window.heldSample.shows[0],${JSON.stringify(patch)})`);
    await until(() => run(`return window.polls>${before}`));
    await wait(40);
  };
  await change({status: 'Paused', left: 12});
  assert.ok(Math.abs(await edge()-30) < .001, 'paused bar is the exact server fraction');
  const paused = await edge();
  await wait(1100);
  assert.equal(await edge(), paused);
  await change({status: 'Ready', left: 30});
  assert.equal(await edge(), 0, 'reset restores full bar immediately');
  await change({status: 'Running', left: 15});
  await wait(350);
  assert.ok(await edge() > 25);
  const beforeRestart = await edge();
  const beforePoll = await run('return window.polls');
  await run(`window.heldSample.timerVersions.urgency=['cue',15,'Running',123456789]`);
  await until(() => run(`return window.polls>${beforePoll}`));
  assert.ok(await edge() < beforeRestart, 'observable same-value explicit restart resets visual anchor');
  await change({left: 25});
  assert.ok(await edge() < 10, '+time is responsive');
  await change({left: 5});
  assert.ok(await edge() > 41, '-time is responsive');
  await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await until(async () => Math.abs(await edge()-(1-5/30)*50) < .001);
  const reduced = await edge();
  await wait(650);
  assert.equal(await edge(), reduced, 'reduced motion does not interpolate');
  await change({left: 1});
  await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'no-preference'}]});
  await wait(1400);
  assert.equal(await run(`return !!document.querySelector('[data-countdown-expired]')`), false,
    'visual interpolation never declares expiration before authoritative zero');
  await change({status: 'Complete', left: 0});
  assert.equal(await run(`return !!document.querySelector('[data-countdown-expired]')`), true);
  await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  assert.equal(await run(`return getComputedStyle(document.querySelector('[data-countdown-expired]')).animationName`), 'none');
  await change({status: 'Ready', left: 10, blackout: true});
  assert.equal(await run(`return !!document.querySelector('[data-countdown-bar]')`), false);
  await run(`location.hash='#/control/urgency'`);
  await until(() => run(`return !!document.querySelector('[aria-label="Timer panel"]')`));
  assert.match(await run('return document.body.innerText'), /BLACKOUT ACTIVE.*Timers continue running/);
  await change({blackout: false});
  assert.doesNotMatch(await run('return document.body.innerText'), /Output live|blackout is off|BLACKOUT ACTIVE/);
  await run(`location.hash='#/display/urgency'`);
  await until(() => run(`return !!document.querySelector('[data-countdown-bar]')`));
  await change({cues: [{id: 'cue', name: 'Count-up', type: 'countup', duration: 30}]});
  assert.equal(await run(`return !!document.querySelector('[data-countdown-bar], [data-countdown-expired]')`), false);
  await change({cues: [{id: 'cue', name: 'Local Time', type: 'clock', duration: 30}]});
  assert.equal(await run(`return !!document.querySelector('[data-countdown-bar], [data-countdown-expired]')`), false);
  await change({cues: [{id: 'cue', name: 'Inactive', duration: 0}]});
  assert.equal(await run(`return !!document.querySelector('[data-countdown-bar], [data-countdown-expired]')`), false);
  await change({active: 'other', cues: [{id: 'other', name: 'Next cue', duration: 20}], left: 10});
  assert.ok(Math.abs(await edge()-25) < .001, 'cue changes use the new duration');
  assert.equal((await get()).revision, revision);
  assert.ok((await run('return window.requests')).every(method => method === 'GET'));
  assert.deepEqual(await run('return window.browserErrors'), []);
});
test('browser cue modes, all outputs, workspace layout and dashboard-only deletion', {skip: !enabled}, browserModes);

test('browser saved branding snapshots and shared site settings survive reloads and another browser', {skip: !enabled}, async t => {
  const driver = process.env.CHROMEDRIVER_URL, base = process.env.BROWSER_TEST_URL;
  const command = async (method, endpoint, data) => {
    const response = await fetch(`${driver}${endpoint}`, { method,
      headers: {'Content-Type': 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result.value;
  };
  const start = async name => {
    const profile = path.resolve(`.browser-data/${name}`);
    mkdirSync(profile, {recursive: true});
    const session = await command('POST', '/session', {capabilities: {alwaysMatch: {
      browserName: 'chrome', 'goog:chromeOptions': {args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profile}`]},
    }}});
    const prefix = `/session/${session.sessionId}`;
    t.after(() => command('DELETE', prefix));
    return prefix;
  };
  const prefix = await start('branding-profile');
  const runAt = (target, script) => command('POST', `${target}/execute/sync`, {script, args: []});
  const run = script => runAt(prefix, script);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => {
    const deadline = Date.now() + 8000;
    while (!(await predicate())) {
      if (Date.now() >= deadline) assert.fail(`branding browser condition timed out: ${await run('return document.body.innerText')}`);
      await wait(50);
    }
  };
  const get = () => fetch(`${base}/api.php`).then(response => response.json());
  const save = async data => {
    const response = await fetch(`${base}/api.php`, { method: 'PUT',
      headers: apiHeaders(base), body: JSON.stringify(data) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const original = await get();
  await save({ revision: original.revision, settings: {pin: '', mainHeader: 'Live Event Timers',
    subHeader: 'Show operations · local timer simulation', headerLogo: '', headerLogoName: '',
    headerLogoLight: '', headerLogoDark: '', headerLogoNameLight: '', headerLogoNameDark: ''}, templates: [],
    shows: [{id: 'branding', title: 'Branding', cues: [{id: 'cue', name: 'Opening', duration: 600}],
      active: 'cue', left: 600, status: 'Running', templateId: 'minimal-dark', logoOn: true,
      uploadedLogo: '', uploadedLogoLight: '', uploadedLogoDark: '', logoName: '', logoNameLight: '', logoNameDark: ''}], timerCommands: ['branding'] });
  const click = windowClicks(command, prefix, run, text => run(`Array.from((document.querySelector('[role="dialog"]')||document).querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`));
  const field = (selector, value, select = false) => run(`
    const node=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(node,${JSON.stringify(value)});
    node.dispatchEvent(new Event('${select ? 'change' : 'input'}',{bubbles:true}));
  `);
  const upload = (selector, color = 'blue') => run(`
    const data=new DataTransfer();
    data.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="${color}"/></svg>'],'${color}.svg',{type:'image/svg+xml'}));
    const input=document.querySelector(${JSON.stringify(selector)});input.files=data.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  `);
  await command('POST', `${prefix}/url`, {url: `${base}/#/control/branding`});
  await until(() => run(`return !!document.querySelector('aside [aria-label="Default (light mode)"]')`));
  await run(`localStorage.setItem('lem-time-theme','light')`);
  await command('POST', `${prefix}/refresh`, {});
  await until(() => run(`return !!document.querySelector('aside [aria-label="Default (light mode)"]')`));
  assert.equal(await run(`return document.querySelector('aside details').open`), false, 'Template starts collapsed');
  assert.doesNotMatch(await run(`return document.querySelector('aside').textContent`), /Upload one font for timers and text:/);
  await run(`document.querySelector('aside summary').click()`);
  assert.equal(await run(`return document.querySelectorAll('aside input[type=file]').length`), 3);
  assert.equal(await run(`return document.querySelectorAll('[aria-label="Font"]').length`), 1);
  assert.equal(await run(`return document.querySelector('aside details summary').textContent`), 'Template');
  assert.deepEqual(await run(`return [...document.querySelectorAll('aside details input[type=file]')].map(n=>n.getAttribute('aria-label'))`),
    ['Default (light mode)', 'Dark mode (optional)', 'Font']);
  await run(`window.templateFont=document.querySelector('[aria-label="Font"]');window.templateSelect=document.querySelector('[aria-label="Select template"]');document.querySelector('aside summary').focus()`);
  const templateBeforeCollapse = (await get()).shows[0].templateId;
  const templateKey = value => command('POST', `${prefix}/actions`, {actions: [{
    type: 'key', id: 'keyboard', actions: [{type: 'keyDown', value}, {type: 'keyUp', value}],
  }]});
  await templateKey('\uE007');
  await wait(650);
  assert.equal(await run(`return !document.querySelector('aside details').open&&!window.templateFont.checkVisibility()&&document.querySelector('[aria-label="Message text"]').checkVisibility()`), true, 'only Template contents collapse, including across polls');
  await templateKey(' ');
  assert.equal(await run(`return document.querySelector('aside details').open&&window.templateFont===document.querySelector('[aria-label="Font"]')&&window.templateSelect===document.querySelector('[aria-label="Select template"]')`), true, 'collapse must retain mounted input and selection state');
  assert.equal((await get()).shows[0].templateId, templateBeforeCollapse);
  assert.doesNotMatch(await run(`return document.querySelector('aside').textContent`), /Sample text|0123456789/);
  assert.equal(await run(`return /legacy/i.test(document.querySelector('aside').textContent)`), false);
  const timer = (await get()).timerVersions.branding;
  const fontTests = Boolean(process.env.FONT_TEST_TIMER && process.env.FONT_TEST_TEXT);
  if (fontTests) {
    const uploadFont = (label, name, bytes) => run(`
      const data=new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0))],${JSON.stringify(name)}));
      const input=document.querySelector('[aria-label="${label}"]');input.files=data.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));
    `);
    await uploadFont('Font', 'bad.ttf', Buffer.from('not a font'));
    await until(() => run(`return Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('Invalid font'))`));
    assert.equal((await get()).shows[0].timerFont, undefined);
    await uploadFont('Font', 'too-big.ttf', Buffer.alloc(524289));
    await until(() => run(`return Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('512 KiB'))`));
    await uploadFont('Font', 'timer.ttf', readFileSync(process.env.FONT_TEST_TIMER));
    await until(async () => (await get()).shows[0].timerFont?.name === 'timer.ttf');
    const timerFont = (await get()).shows[0].timerFont;
    assert.deepEqual((await get()).shows[0].textFont, timerFont);
    await uploadFont('Font', 'text.ttf', readFileSync(process.env.FONT_TEST_TEXT));
    await until(async () => (await get()).shows[0].textFont?.name === 'text.ttf');
    assert.deepEqual((await get()).shows[0].timerFont, (await get()).shows[0].textFont);
    // Legacy split-font data remains intact and is described truthfully.
    const split = await get();
    await save({...split, shows: [{...split.shows[0], timerFont}], timerCommands: []});
    await until(() => run(`return document.querySelector('[aria-label="Font"]').closest('fieldset').textContent.includes('Mixed legacy fonts')`));
    assert.match(await run(`return document.querySelector('[aria-label="Font"]').closest('fieldset').textContent`), /Timer: timer.ttf.*Text: text.ttf/);
    const families = () => run(`return Array.from(document.querySelectorAll('[data-font-role=timer]')).map(e=>getComputedStyle(e).fontFamily)`);
    await until(async () => (await families()).every(f => f.startsWith('ShowFont')));
    const stable = await families();
    const resources = await run(`return [...document.fonts].map(f=>f.family).sort()`);
    await wait(1100);
    assert.deepEqual(await families(), stable, 'polls must not recreate loaded resources');
    assert.deepEqual(await run(`return [...document.fonts].map(f=>f.family).sort()`), resources);
    assert.equal(await run(`return getComputedStyle(document.querySelector('header h1')).fontFamily.startsWith('ShowFont')`), false);
    assert.equal(await run(`return getComputedStyle(document.querySelector('[aria-label="Bayer-style placeholder wordmark"]')).fontFamily.startsWith('ShowFont')`), false);
    let data = await get();
    await save({...data, timerCommands: [], shows: [{...data.shows[0],
      message: {text: 'Font message', destinations: {display: true, dsm: false}}}]});
    await until(() => run(`const text=document.querySelector('[aria-label="Published workspace message"] [data-font-role="text"]');return text?.textContent==='Font message'&&getComputedStyle(text).fontFamily.startsWith('ShowFont')`));
    await click('Preview display');
    await until(() => run(`return Array.from(document.querySelectorAll('[data-font-role=text]')).some(e=>e.textContent==='Font message'&&getComputedStyle(e).fontFamily.startsWith('ShowFont'))`));
    await click('Back to Show');
    for (const [open, expand, exit] of [
      ['Open DSM', 'Expand DSM display', 'Exit DSM presentation'],
      ['Open Chroma mode', 'Expand Chroma display', 'Exit Chroma presentation'],
    ]) {
      await click(open);
      await until(async () => (await families()).every(f => f.startsWith('ShowFont')));
      const element = await command('POST', `${prefix}/element`, {using:'css selector',value:`[aria-label="${expand}"]`});
      await command('POST', `${prefix}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
      await until(() => run(`return !!document.fullscreenElement && !!document.querySelector('[aria-label="${exit}"]')`));
      await until(async () => (await families()).every(f => f.startsWith('ShowFont')));
      await run(`document.querySelector('[aria-label="${exit}"]').click()`);
      if (open === 'Open DSM') {
        await until(() => run(`return !!document.querySelector('[aria-label="Expand DSM display"]')`));
        await click('Back to Show');
      } else {
        await click('Back to Show');
      }
      await until(() => run(`return !!document.querySelector('[aria-label="Font"]')`));
    }
    assert.deepEqual((await get()).timerVersions.branding, timer);
    await command('POST', `${prefix}/refresh`, {});
    await until(() => run(`return !!document.querySelector('[aria-label="Font"]')`));
    assert.equal(await run(`return document.querySelector('aside details').open`), false);
    await run(`document.querySelector('aside summary').click()`);
    await until(async () => (await families()).every(f => f.startsWith('ShowFont')));
    assert.match(await run(`return document.querySelector('[aria-label="Font"]').closest('fieldset').textContent`), /text.ttf.*KiB/);
    await click('Remove font');
    await until(async () => (await get()).shows[0].timerFont === null && (await get()).shows[0].textFont === null);
    await until(async () => (await families()).every(f => !f.startsWith('ShowFont')));
    await until(() => run(`return document.fonts.size===0`));
    await run(`
      const original=File.prototype.arrayBuffer;
      File.prototype.arrayBuffer=function(){
        return this.name==='race.ttf' ? new Promise(resolve=>{
          window.releaseFont=()=>resolve(original.call(this));
        }) : original.call(this);
      };
    `);
    await uploadFont('Font', 'race.ttf', readFileSync(process.env.FONT_TEST_TIMER));
    await until(() => run(`return typeof window.releaseFont==='function'`));
    await run(`document.querySelector('aside summary').click();window.releaseFont()`);
    await until(async () => (await get()).shows[0].timerFont?.name === 'race.ttf');
    assert.equal(await run(`return document.querySelector('aside details').open`), false, 'a completed upload must not reopen the panel');
    await run(`document.querySelector('aside summary').click()`);
    assert.match(await run(`return document.querySelector('[aria-label="Font"]').closest('fieldset').textContent`), /race.ttf/);
    await click('Remove font');
    await until(async () => (await get()).shows[0].timerFont === null);
    await run(`window.releaseFont=null`);
    await uploadFont('Font', 'race.ttf', readFileSync(process.env.FONT_TEST_TIMER));
    await until(() => run(`return typeof window.releaseFont==='function'`));
    await apiAction(base, 'configure', '2468');
    await until(() => run(`return document.querySelector('[aria-label="Message text"]').matches(':disabled')`));
    await run(`window.releaseFont()`);
    await until(() => run(`return !document.querySelector('[aria-label="Font"]').closest('fieldset').textContent.includes('Validating')`));
    assert.equal((await get()).shows[0].timerFont, null, 'a PIN lock during validation must discard the upload');
    assert.equal((await get()).shows[0].textFont, null);
    await apiAction(base, 'configure', '');
    await until(() => run(`return !document.querySelector('[aria-label="Font"]').closest('fieldset').disabled`));
    await run(`window.releaseFont=null`);
    await uploadFont('Font', 'race.ttf', readFileSync(process.env.FONT_TEST_TIMER));
    await until(() => run(`return typeof window.releaseFont==='function'`));
    await click('← All Shows');
    await run(`window.releaseFont()`);
    await wait(700);
    assert.equal((await get()).shows[0].timerFont, null, 'unmounting during validation must discard the upload');
    await run(`document.querySelector('[aria-label="Open Branding"]').click()`);
    await until(() => run(`return !!document.querySelector('[aria-label="Font"]')`));
    // Restore the fonts for the template, reload, and second-browser checks below.
    await uploadFont('Font', 'text.ttf', readFileSync(process.env.FONT_TEST_TEXT));
    await until(async () => (await get()).shows[0].textFont?.name === 'text.ttf');
    const restored = await get();
    await save({...restored, shows: [{...restored.shows[0], timerFont}], timerCommands: []});
    await until(() => run(`return document.querySelector('[aria-label="Font"]').closest('fieldset').textContent.includes('Mixed legacy fonts')`));
  }
  await upload('aside [aria-label="Default (light mode)"]', 'red');
  await until(async () => Boolean((await get()).shows[0].uploadedLogoLight));
  await upload('aside [aria-label="Dark mode (optional)"]', 'white');
  await until(async () => Boolean((await get()).shows[0].uploadedLogoDark));
  const lightLogo = (await get()).shows[0].uploadedLogoLight;
  const darkLogo = (await get()).shows[0].uploadedLogoDark;
  const previewLogo = async () => {
    await click('Preview display');
    await until(() => run(`return !!document.querySelector('section img')`));
    const src = await run(`return document.querySelector('section img').getAttribute('src')`);
    await click('Back to Show');
    return src;
  };
  assert.equal(await previewLogo(), darkLogo);
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Bayer Light')).click()`);
  assert.equal(await previewLogo(), lightLogo);
  await run(`document.querySelector('[aria-label="Dark mode"]').click()`);
  await until(() => run(`return document.documentElement.dataset.theme==='dark'`));
  assert.equal(await previewLogo(), lightLogo, 'output stays light despite operator dark mode');
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Bayer Blue')).click()`);
  assert.equal(await previewLogo(), darkLogo);
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Minimal Dark')).click()`);
  await upload('aside [aria-label="Default (light mode)"]', 'green');
  await until(async () => (await get()).shows[0].logoNameLight === 'green.svg');
  const replacementLight = (await get()).shows[0].uploadedLogoLight;
  await click('+ Add template');
  await field('[role="dialog"] input', 'Event branding');
  await click('Save template');
  await until(async () => (await get()).templates.length === 1);
  const saved = (await get()).templates[0];
  assert.deepEqual(Object.keys(saved).sort(), ['id', 'logoName', 'logoNameDark', 'logoNameLight', 'logoOn', 'name', 'templateId', 'textFont', 'timerFont', 'uploadedLogo', 'uploadedLogoDark', 'uploadedLogoLight']);
  if (fontTests) {
    assert.equal(saved.timerFont.name, 'timer.ttf'); assert.equal(saved.textFont.name, 'text.ttf');
    await click('Remove font');
    await until(async () => (await get()).shows[0].timerFont === null && (await get()).shows[0].textFont === null);
  }
  assert.equal(saved.uploadedLogoLight, replacementLight);
  assert.equal(saved.uploadedLogoDark, darkLogo);
  await click('+ Add template');
  await field('[role="dialog"] input', 'event branding');
  await click('Save template');
  assert.match(await run('return document.querySelector(\'[role="dialog"]\').textContent'), /already exists/);
  await click('Close');
  await click('Remove default (light mode)');
  await until(async () => (await get()).shows[0].uploadedLogoLight === '');
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Bayer Light')).click()`);
  await click('Preview display');
  assert.equal(await run(`return !!document.querySelector('section [aria-label="Bayer-style placeholder wordmark"]')`), true);
  await click('Back to Show');
  assert.equal((await get()).shows[0].uploadedLogoDark, darkLogo);
  await command('POST', `${prefix}/refresh`, {});
  await until(() => run(`return !!document.querySelector('aside [aria-label="Default (light mode)"]')`));
  await run(`document.querySelector('aside summary').click()`);
  assert.equal((await get()).shows[0].uploadedLogoLight, '', 'deleted default survives reload despite dark upload');
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Bayer Blue')).click()`);
  assert.equal(await previewLogo(), darkLogo);
  await click('Remove dark mode (optional)');
  await click('Preview display');
  assert.equal(await run(`return !!document.querySelector('section [aria-label="Bayer-style placeholder wordmark"]')`), true);
  await click('Back to Show');
  await until(async () => !(await get()).shows[0].uploadedLogo);
  assert.equal((await get()).templates[0].uploadedLogo, '');
  await field('[aria-label="Select template"]', `saved:${saved.id}`, true);
  await until(async () => (await get()).shows[0].uploadedLogoLight === replacementLight && (await get()).shows[0].templateId === 'minimal-dark');
  await run(`window.selectedTemplate=document.querySelector('[aria-label="Select template"]');document.querySelector('aside summary').focus()`);
  assert.equal(await run(`return document.documentElement.dataset.theme`), 'dark');
  await templateKey('\uE007');
  assert.equal(await run(`return !document.querySelector('aside details').open&&document.activeElement===document.querySelector('aside summary')&&getComputedStyle(document.activeElement).boxShadow!=='none'`), true, 'Template heading stays focusable in dark mode');
  await templateKey('\uE007');
  assert.equal(await run(`return window.selectedTemplate===document.querySelector('[aria-label="Select template"]')&&window.selectedTemplate.value===${JSON.stringify(`saved:${saved.id}`)}`), true, 'saved template selection survives collapse');
  if (fontTests) {
    assert.equal((await get()).shows[0].timerFont.name, 'timer.ttf');
    assert.equal((await get()).shows[0].textFont.name, 'text.ttf');
  }
  assert.deepEqual((await get()).timerVersions.branding, timer);
  assert.equal((await get()).shows[0].uploadedLogoLight, replacementLight);
  assert.equal((await get()).shows[0].uploadedLogoDark, darkLogo);
  await click('Remove dark mode (optional)');
  await until(async () => (await get()).shows[0].uploadedLogoDark === '');
  assert.equal(await previewLogo(), replacementLight, 'dark design uses default when optional dark is removed');
  await upload('aside [aria-label="Dark mode (optional)"]', 'white');
  await until(async () => (await get()).shows[0].uploadedLogoDark === darkLogo);
  assert.equal(await run(`const image=document.querySelector('aside img');return image.complete&&image.naturalWidth===20`), true);
  await click('Settings');
  assert.match(await run(`return document.querySelector('[role="dialog"]').textContent`), /operator PIN/);
  assert.equal(await run(`return document.querySelectorAll('[role="dialog"] input[type=file]').length`), 2);
  assert.equal(await run(`return /legacy/i.test(document.querySelector('[role="dialog"]').textContent)`), false);
  await upload('[role="dialog"] [aria-label="Default (light mode)"]', 'red');
  await until(() => run(`return document.querySelector('[alt="Default (light mode) preview"]')?.complete`));
  await upload('[role="dialog"] [aria-label="Dark mode (optional)"]', 'white');
  await until(() => run(`return document.querySelector('[alt="Dark mode (optional) preview"]')?.complete`));
  const setLabel = (text, value) => run(`
    const node=Array.from(document.querySelectorAll('[role="dialog"] label')).find(l=>l.textContent.startsWith(${JSON.stringify(text)})).querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});
    node.dispatchEvent(new Event('input',{bubbles:true}));
  `);
  await setLabel('Main header', '<b>Conference team</b>');
  await setLabel('Sub-header text', 'Live from stage');
  await click('Save settings');
  await until(async () => (await get()).settings.mainHeader === '<b>Conference team</b>');
  assert.equal(await run(`return document.querySelector('header h1').textContent`), '<b>Conference team</b>');
  assert.equal(await run(`return document.querySelector('header h1 b')===null`), true);
  const header = (await get()).settings;
  const visibleHeader = target => runAt(target, `return Array.from(document.querySelectorAll('header img')).find(img=>img.getClientRects().length)?.getAttribute('src')`);
  assert.equal(await visibleHeader(prefix), header.headerLogoDark);
  await run(`document.querySelector('[aria-label="Dark mode"]').click()`);
  await until(async () => await visibleHeader(prefix) === header.headerLogoLight);
  await run(`document.querySelector('[aria-label="Dark mode"]').click()`);
  const second = await start('branding-other-browser');
  await command('POST', `${second}/url`, {url: `${base}/#/control/branding`});
  await until(() => runAt(second, `return document.querySelector('header h1')?.textContent==='<b>Conference team</b>'`));
  assert.equal(await visibleHeader(second), header.headerLogoLight);
  assert.equal(await runAt(second, `return document.querySelector('[aria-label="Select template"]').options[1].textContent`), 'Event branding');
  await command('POST', `${prefix}/refresh`, {});
  await until(() => run(`return document.querySelector('header h1')?.textContent==='<b>Conference team</b>'`));
  assert.equal(await visibleHeader(prefix), header.headerLogoDark, 'saved dark theme and variant survive refresh');
  assert.equal((await get()).shows[0].uploadedLogoLight, replacementLight);
  await command('POST', `${prefix}/url`, {url: `${base}/#/display/branding`});
  await until(() => run(`return !!document.querySelector('section img')`));
  assert.equal(await run(`return document.querySelector('section img').getAttribute('src')`), darkLogo);
  await click('Back to Show');
  await click('Settings');
  await setLabel('Main header', 'Unsaved local header');
  const overlapping = await get();
  await save({...overlapping, settings: {...overlapping.settings, mainHeader: 'Concurrent header'}, timerCommands: []});
  await until(() => run(`return document.querySelector('header h1')?.textContent==='Concurrent header'`));
  await click('Save settings');
  assert.match(await run(`return document.querySelector('[role="dialog"] [role="alert"]').textContent`), /changed in another window/);
  assert.equal((await get()).settings.mainHeader, 'Concurrent header');
  await click('Close');
  await click('Settings');
  await setLabel('Main header', 'Disjoint local header');
  const disjoint = await get();
  await save({...disjoint, settings: {...disjoint.settings, subHeader: 'Disjoint remote sub-header'}, timerCommands: []});
  await until(() => run(`return document.querySelector('header p')?.textContent==='Disjoint remote sub-header'`));
  await click('Save settings');
  await until(async () => (await get()).settings.mainHeader === 'Disjoint local header');
  assert.equal((await get()).settings.subHeader, 'Disjoint remote sub-header');
  await click('Settings');
  await click('Remove dark mode (optional)');
  await click('Save settings');
  await until(async () => (await get()).settings.headerLogoDark === '');
  await until(async () => await visibleHeader(prefix) === header.headerLogoLight);
  await command('POST', `${prefix}/refresh`, {});
  await until(async () => await visibleHeader(prefix) === header.headerLogoLight);
  assert.equal(await run(`return document.documentElement.dataset.theme`), 'dark', 'logo default never changes UI theme preference');
  await click('Settings');
  await upload('[role="dialog"] [aria-label="Dark mode (optional)"]', 'white');
  await until(() => run(`return document.querySelector('[alt="Dark mode (optional) preview"]')?.complete`));
  await click('Remove default (light mode)');
  await click('Save settings');
  await until(async () => (await get()).settings.headerLogoLight === '' && (await get()).settings.headerLogoDark === header.headerLogoDark);
  await until(async () => await visibleHeader(prefix) === header.headerLogoDark);
  await run(`document.querySelector('[aria-label="Dark mode"]').click()`);
  await until(() => run(`return !!document.querySelector('.theme-logo-light [aria-label="Bayer-style placeholder wordmark"]')`));
  await command('POST', `${prefix}/refresh`, {});
  await until(() => run(`return !!document.querySelector('.theme-logo-light [aria-label="Bayer-style placeholder wordmark"]')`));
  assert.equal((await get()).settings.headerLogoLight, '');
  await run(`if(document.documentElement.dataset.theme!=='dark')document.querySelector('[aria-label="Dark mode"]').click()`);
  await click('Settings');
  await command('POST', `${prefix}/window/rect`, {width: 390, height: 740});
  assert.equal(await run(`const r=document.querySelector('[role="dialog"]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height<=innerHeight`), true);
  assert.notEqual(await run(`return getComputedStyle(document.querySelector('[role="dialog"]')).backgroundColor`), 'rgb(255, 255, 255)');
  await click('Reset to defaults');
  await click('Save settings');
  await until(() => runAt(second, `return document.querySelector('header h1')?.textContent==='Live Event Timers'&&!document.querySelector('header img')`));
  await click('← All Shows');
  await click('Add Show');
  await field('[role="dialog"] input', 'From saved branding');
  await field('[role="dialog"] [aria-label="Select template"]', `saved:${saved.id}`, true);
  await click('Create Show');
  await until(async () => (await get()).shows.length === 2);
  const created = (await get()).shows[1];
  assert.equal(created.uploadedLogo, '');
  assert.equal(created.uploadedLogoLight, replacementLight);
  assert.equal(created.uploadedLogoDark, darkLogo);
  assert.equal(created.templateId, 'minimal-dark');
  assert.deepEqual(created.cues, []);
  assert.equal(created.status, 'Ready');
  const legacy = await get();
  const oversized = 'data:image/png;base64,' + 'A'.repeat(720000);
  await save({...legacy, shows: legacy.shows.map(show => show.id === created.id
    ? {...show, uploadedLogo: oversized, uploadedLogoLight: oversized, logoName: 'legacy-large.png', logoNameLight: 'legacy-large.png'} : show), timerCommands: []});
  await until(() => run(`return document.querySelector('aside').textContent.includes('legacy-large.png')`));
  await click('+ Add template');
  await field('[role="dialog"] input', 'Legacy large logo');
  await click('Save template');
  assert.match(await run(`return document.querySelector('[role="dialog"] [role="alert"]').textContent`), /replace or remove the show logo/);
  assert.equal((await get()).templates.length, 1);
  await click('Close');
  await click('Remove default (light mode)');
  await until(async () => !(await get()).shows.find(show => show.id === created.id).uploadedLogo);
});

test('browser message Show toggle, live edits, retained drafts, remote safety, routing and PIN lock', {skip: !enabled}, async t => {
  const driver = process.env.CHROMEDRIVER_URL, base = process.env.BROWSER_TEST_URL;
  const profile = path.resolve('.browser-data/messages-profile');
  mkdirSync(profile, {recursive: true});
  const command = async (method, endpoint, data) => {
    const response = await fetch(`${driver}${endpoint}`, {method,
      headers: {'Content-Type': 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data)});
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result.value;
  };
  const session = await command('POST', '/session', {capabilities: {alwaysMatch: {
    browserName: 'chrome', 'goog:chromeOptions': {args: [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profile}`,
    ]},
  }}});
  const prefix = `/session/${session.sessionId}`;
  t.after(() => command('DELETE', prefix));
  const run = script => command('POST', `${prefix}/execute/sync`, {script, args: []});
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => {
    const deadline = Date.now() + 7000;
    while (!(await predicate())) {
      if (Date.now() >= deadline) assert.fail(`message browser condition timed out: ${await run('return document.body.innerText')}`);
      await wait(50);
    }
  };
  const click = windowClicks(command, prefix, run, text => run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}).click()`));
  const field = (selector, value, textarea = false) => run(`
    const node=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(${textarea ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype,'value').set.call(node,${JSON.stringify(value)});
    node.dispatchEvent(new Event('input',{bubbles:true}));
    node.dispatchEvent(new Event('change',{bubbles:true}));
  `);
  const get = () => fetch(`${base}/api.php`).then(response => response.json());
  const save = async data => {
    const response = await fetch(`${base}/api.php`, {method: 'PUT', headers: apiHeaders(base), body: JSON.stringify(data)});
    assert.equal(response.status, 200);
    return response.json();
  };
  const original = await get();
  const seed = {id: 'messages', title: 'Message show', active: 'cue', left: 300, status: 'Running',
    cues: [{id: 'cue', name: 'Timer', duration: 300}], templateId: 'bayer-light', logoOn: false};
  const composer = '[aria-label="On-screen messages"]';
  let legacyState = original;
  for (const legacyMessage of [
    {text: '', destinations: {display: true, dsm: false}},
    {text: ' \n ', destinations: {display: true, dsm: false}},
    {text: 'a'.repeat(501), destinations: {display: true, dsm: false}},
    {text: 'Legacy unselected', destinations: {display: false, dsm: false}},
  ]) {
    legacyState = await save({revision: legacyState.revision, settings: {pin: ''},
      shows: [{...seed, message: legacyMessage}], templates: [], timerCommands: []});
    await command('POST', `${prefix}/url`, {url: `${base}/#/control/messages`});
    await command('POST', `${prefix}/refresh`, {});
    await until(() => run(`return document.querySelector('[aria-label="Message text"]')?.value===${JSON.stringify(legacyMessage.text)}`));
    assert.equal(await run(`return !!document.querySelector('[aria-label="Published workspace message"]')`), legacyMessage.text.length > 500);
    assert.equal(await run(`const button=document.querySelector('${composer} [title="Toggle message"]');return !button.disabled&&button.getAttribute('aria-pressed')==='true'`), true, 'even invalid legacy messages can be switched off');
    await click('Preview display');
    await until(() => run(`return [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Back to Show')`));
    assert.equal(await run(`return document.querySelectorAll('[data-output-message]').length>0`), legacyMessage.text.length > 500);
    assert.deepEqual((await get()).shows[0].message, legacyMessage);
    await click('Back to Show');
    await until(() => run(`return !!document.querySelector('${composer}')`));
  }
  await click('Show');
  await until(async () => !(await get()).shows[0].message);
  await click('DISPLAY');
  await click('Show');
  await until(async () => (await get()).shows[0].message?.color === '#ffffff');
  assert.deepEqual((await get()).shows[0].message, {
    text: 'Legacy unselected', destinations: {display: true, dsm: false, chroma: false},
    color: '#ffffff', flash: false,
  });
  const initial = await save({revision: (await get()).revision, settings: {pin: ''},
    shows: [seed, {...seed, id: 'other', title: 'Other show'}], templates: [], timerCommands: ['messages', 'other']});
  await command('POST', `${prefix}/url`, {url: `${base}/#/control/messages`});
  await command('POST', `${prefix}/refresh`, {});
  await until(() => run(`return !!document.querySelector('${composer}')`));
  assert.equal(await run(`return document.querySelector('aside').firstElementChild.getAttribute('aria-label')`), 'On-screen messages');
  assert.equal(await run(`return document.querySelector('${composer}').nextElementSibling.innerText.includes('Template')`), true);
  assert.equal(await run(`return document.querySelectorAll('${composer} [title="Toggle message"]').length`), 1);
  assert.equal(await run(`return !!document.querySelector('${composer} [aria-label="Expand message editor"], ${composer} .message-caption, ${composer} [role="status"]')`), false);
  assert.doesNotMatch(await run(`return document.querySelector('${composer}').textContent`), /Hide|Draft until|Current output|\/500/);
  for (const [theme, panel, input, text, selected, focus, disabled] of [
    ['light', 'rgb(255, 255, 255)', 'rgb(248, 250, 252)', 'rgb(15, 23, 42)', 'rgb(224, 242, 254)', 'rgb(0, 105, 180)', 'rgb(100, 116, 139)'],
    ['dark', 'rgb(30, 41, 59)', 'rgb(15, 23, 42)', 'rgb(226, 232, 240)', 'rgb(51, 65, 85)', 'rgb(125, 211, 252)', 'rgb(148, 163, 184)'],
  ]) {
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    const textarea = await command('POST', `${prefix}/element`, {using: 'css selector', value: `${composer} textarea`});
    await command('POST', `${prefix}/element/${textarea['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
    assert.deepEqual(await run(`
      const panel=document.querySelector('${composer}'), input=panel.querySelector('textarea');
      const chosen=panel.querySelector('[aria-label="Message destinations"] [aria-pressed="true"]');
      const send=panel.querySelector('[title="Toggle message"]');
      return [getComputedStyle(panel).backgroundColor,getComputedStyle(input).backgroundColor,
        getComputedStyle(input).color,getComputedStyle(chosen).backgroundColor,
        getComputedStyle(input).outlineColor,
        getComputedStyle(send).color,send.disabled,getComputedStyle(panel.querySelector('[aria-label="White"]'),'::after').boxShadow!=='none'];
    `), [panel, input, text, selected, focus, disabled, true, true]);
  }
  await run(`document.documentElement.dataset.theme='light'`);
  const plain = '<img src=x onerror="window.messageExecuted=true">\nSecond line & <b>plain text</b>';
  await field('[aria-label="Message text"]', plain, true);
  await click('DSM');
  await click('CHROMA');
  await click('Yellow');
  await run(`document.querySelector('[aria-label="Flash message"]').click()`);
  await wait(1400);
  assert.equal((await get()).shows[0].message, undefined);
  assert.equal(await run(`return document.querySelector('${composer} [title="Toggle message"]').getAttribute('aria-pressed')`), 'false');
  assert.equal(await run(`return getComputedStyle(document.querySelector('.message-status-dot')).backgroundColor`), 'rgb(170, 170, 170)');
  assert.equal(await run(`return document.querySelectorAll('[data-output-message]').length`), 0);
  assert.deepEqual(await run(`return [...document.querySelectorAll('[aria-label="Message destinations"] button')].map(b=>b.getAttribute('aria-pressed'))`), ['true', 'true', 'true']);
  await click('Show');
  await until(async () => (await get()).shows[0].message?.text === plain);
  assert.equal(await run(`return document.querySelector('${composer} [title="Toggle message"]').getAttribute('aria-pressed')`), 'true');
  assert.equal(await run(`return getComputedStyle(document.querySelector('.message-status-dot')).backgroundColor`), 'rgb(34, 197, 94)');
  assert.deepEqual((await get()).timerVersions, initial.timerVersions);
  assert.equal((await get()).shows[0].message.color, '#facc15');
  assert.equal((await get()).shows[0].message.flash, true);
  assert.equal(await run(`return document.querySelector('[aria-label="Published workspace message"] [data-font-role="text"]')?.textContent`), plain);
  assert.equal(await run(`return getComputedStyle(document.querySelector('[aria-label="Published workspace message"] [data-font-role="text"]')).fontWeight`), '700');
  assert.equal(await run(`const region=document.querySelector('[aria-label="Published workspace message"]');const text=region.querySelector('[data-font-role="text"]');const timer=document.querySelector('[aria-label="Current timer value"]');return region.parentElement===timer.parentElement.parentElement&&region.getBoundingClientRect().bottom<=timer.getBoundingClientRect().top&&getComputedStyle(text).position==='static'&&text.classList.contains('output-message-flash')&&getComputedStyle(text).color==='rgb(250, 204, 21)'`), true);
  assert.equal(await run(`return document.querySelector('.workspace-message-destinations').textContent`), 'Live message · DSM · CHROMA · DISPLAY');
  assert.equal(await run(`return !!document.querySelector('[aria-label="Published display preview"], .display-preview')||document.body.innerText.includes('Live DISPLAY preview')`), false);
  const workspaceMessageSize = await run(`return parseFloat(getComputedStyle(document.querySelector('[aria-label="Published workspace message"] [data-font-role="text"]')).fontSize)`);
  await click('Preview display');
  await until(() => run(`return document.querySelector('[data-output-message="display"]')?.textContent===${JSON.stringify(plain)}`));
  assert.equal(await run(`return !!document.querySelector('[data-output-message] img, [data-output-message] b')||!!window.messageExecuted`), false);
  assert.equal(await run(`const node=document.querySelector('[data-output-message]');return getComputedStyle(node).whiteSpace==='pre-wrap'&&node.classList.contains('output-message-flash')`), true);
  assert.ok(await run(`return parseFloat(getComputedStyle(document.querySelector('[data-output-message]')).fontSize)>${workspaceMessageSize}*2.5`),
    'real output messages must be dramatically larger than the inline workspace representation');
  await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Emulation.setEmulatedMedia',
    params: {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]}});
  assert.equal(await run(`return getComputedStyle(document.querySelector('[data-output-message]')).animationName`), 'none');
  await click('Back to Show');
  await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Emulation.setEmulatedMedia',
    params: {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]}});
  assert.equal(await run(`return getComputedStyle(document.querySelector('[aria-label="Published workspace message"] [data-font-role="text"]')).animationName`), 'none');
  await field('[aria-label="Message text"]', 'Unsent next draft', true);
  await until(async () => (await get()).shows[0].message?.text === 'Unsent next draft');
  await click('Red');
  await until(async () => (await get()).shows[0].message?.color === '#ef233c');
  await run(`document.querySelector('[aria-label="Flash message"]').click()`);
  await wait(1200);
  assert.equal((await get()).shows[0].message.text, 'Unsent next draft');
  assert.equal((await get()).shows[0].message.color, '#ef233c');
  assert.equal((await get()).shows[0].message.flash, false);
  assert.equal(await run(`return document.querySelector('[aria-label="Published workspace message"] [data-font-role="text"]')?.textContent`), 'Unsent next draft');
  await click('Bold message');
  await until(async () => (await get()).shows[0].message?.bold === false);
  await click('Uppercase message');
  await until(async () => (await get()).shows[0].message?.uppercase === true);
  const live = await get();
  await save({...live, shows: live.shows.map(s => s.id === 'messages' ? {...s, message: {...s.message, text: 'Remote live'}} : s), timerCommands: []});
  await until(() => run(`return document.querySelector('[aria-label="Published workspace message"] [data-font-role="text"]')?.textContent==='REMOTE LIVE'`));
  assert.equal(await run(`return document.querySelector('[aria-label="Message text"]').value`), 'Unsent next draft');
  await click('← All Shows');
  assert.equal(await run(`return document.querySelector('[aria-label="Live normal display thumbnail"] [data-output-message="display"]')?.textContent`), 'REMOTE LIVE');
  assert.ok(await run(`return parseFloat(getComputedStyle(document.querySelector('[aria-label="Live normal display thumbnail"] [data-output-message="display"]')).fontSize)<=10`),
    'dashboard thumbnail messages keep their compact override');
  await run(`document.querySelector('[aria-label="Open Other show"]').click()`);
  await until(() => run(`return document.querySelector('[aria-label="Message text"]')?.value===''`));
  await field('[aria-label="Message text"]', 'Other draft', true);
  await click('← All Shows');
  await run(`document.querySelector('[aria-label="Open Message show"]').click()`);
  await until(() => run(`return document.querySelector('[aria-label="Message text"]')?.value==='Unsent next draft'`));
  const beforeRemoteFormat = (await get()).revision;
  await wait(800);
  assert.equal((await get()).revision, beforeRemoteFormat, 'polls and remounting must not echo a stale draft');
  await click('Green');
  await until(async () => (await get()).shows[0].message?.color === '#22c55e');
  assert.equal((await get()).shows[0].message.text, 'Remote live', 'formatting must preserve freshest remote text');
  await field('[aria-label="Message text"]', 'Unsent next draft', true);
  await until(async () => (await get()).shows[0].message?.text === 'Unsent next draft');
  assert.equal((await get()).shows[0].message.color, '#22c55e');
  assert.equal((await get()).shows[0].message.flash, false);
  assert.equal((await get()).shows[0].message.bold, false);
  assert.equal((await get()).shows[0].message.uppercase, true);
  await until(() => run(`return document.querySelector('[aria-label="Published workspace message"] [data-font-role="text"]')?.textContent==='UNSENT NEXT DRAFT'`));
  assert.equal(await run(`return getComputedStyle(document.querySelector('[aria-label="Published workspace message"] [data-font-role="text"]')).fontWeight`), '400');
  const beforePreviewBlackout = await get();
  await save({...beforePreviewBlackout, shows: beforePreviewBlackout.shows.map(s => s.id === 'messages' ? {...s, blackout: true} : s), timerCommands: []});
  await until(() => run(`return [...document.querySelectorAll('[role="status"]')].some(n=>n.textContent.includes('BLACKOUT ACTIVE'))`));
  assert.equal(await run(`return document.querySelectorAll('[aria-label="Published workspace message"]').length`), 0);
  assert.equal(await run(`return document.querySelector('${composer} [title="Toggle message"]').getAttribute('aria-pressed')`), 'true');
  assert.equal(await run(`return getComputedStyle(document.querySelector('.message-status-dot')).backgroundColor`), 'rgb(34, 197, 94)', 'blackout must not turn the toggle off');
  const afterPreviewBlackout = await get();
  await save({...afterPreviewBlackout, shows: afterPreviewBlackout.shows.map(s => ({...s, blackout: false})), timerCommands: []});
  await until(() => run(`return !!document.querySelector('[aria-label="Published workspace message"]')`));
  await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Emulation.setDeviceMetricsOverride',
    params: {width: 320, height: 800, deviceScaleFactor: 1, mobile: false}});
  for (const theme of ['light', 'dark']) {
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    assert.equal(await run(`return document.documentElement.scrollWidth<=innerWidth`), true);
    assert.equal(await run(`return [...document.querySelectorAll('${composer} button')].every(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})`), true);
  }
  await run(`document.documentElement.dataset.theme='light'`);
  assert.equal(await run(`const region=document.querySelector('[aria-label="Published workspace message"]');return region.scrollWidth<=region.clientWidth&&[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='Pause'&&!n.disabled)&&[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='Reset'&&!n.disabled)`), true);
  await command('POST', `${prefix}/goog/cdp/execute`, {cmd: 'Emulation.clearDeviceMetricsOverride', params: {}});
  await click('Show');
  await until(async () => !(await get()).shows[0].message);
  assert.equal(await run(`return document.querySelector('[aria-label="Message text"]').value`), 'Unsent next draft');
  assert.equal(await run(`return document.querySelectorAll('[aria-label="Published workspace message"]').length`), 0);
  await click('Red');
  await field('[aria-label="Message text"]', 'Hidden edited draft', true);
  await wait(900);
  assert.equal((await get()).shows[0].message, undefined, 'hidden edits never republish');
  await field('[aria-label="Message text"]', 'Unsent next draft', true);
  await click('Show');
  await until(async () => (await get()).shows[0].message?.text === 'Unsent next draft');
  await click('Uppercase message');
  await click('Bold message');
  await click('Green');
  await until(async () => (await get()).shows[0].message?.color === '#22c55e');
  await click('Custom');
  await field('[aria-label="Custom message color"]', '#123abc');
  await until(async () => (await get()).shows[0].message?.color === '#123abc');
  const expectOutput = async destination => {
    await until(() => run(`return !!document.querySelector('[data-output-message="${destination}"]')`));
    assert.deepEqual(await run(`return [...new Set([...document.querySelectorAll('[data-output-message]')].map(n=>n.dataset.outputMessage))]`), [destination]);
    assert.ok(await run(`const size=parseFloat(getComputedStyle(document.querySelector('[data-output-message]')).fontSize);return size>=32&&Math.abs(size-Math.min(96,Math.max(32,innerWidth*.06)))<1`),
      'each actual output uses the large responsive message size');
  };
  const blackout = async value => {
    const current = await get();
    await save({...current, shows: current.shows.map(s => s.id === 'messages' ? {...s, blackout: value} : s), timerCommands: []});
    if (value) {
      await until(() => run(`return !!document.querySelector('[aria-label="Blackout active"]')`));
      assert.equal(await run(`return document.querySelectorAll('[data-output-message]').length`), 0);
    }
  };
  await click('Preview display');
  await expectOutput('display');
  assert.equal(await run(`return getComputedStyle(document.querySelector('[data-output-message]')).color`), 'rgb(18, 58, 188)');
  await blackout(true);
  await blackout(false);
  await expectOutput('display');
  await click('Back to Show');
  await click('Open DSM');
  await expectOutput('dsm');
  assert.equal(await run(`return getComputedStyle(document.querySelector('[aria-label="DSM output"]')).backgroundColor`), 'rgba(0, 0, 0, 0)');
  await run(`document.querySelector('[aria-label="Expand DSM display"]').click()`);
  await expectOutput('dsm');
  await blackout(true);
  await blackout(false);
  await expectOutput('dsm');
  await run(`document.querySelector('[aria-label="Exit DSM presentation"]').click()`);
  await click('Back to Show');
  await click('Open Chroma mode');
  await expectOutput('chroma');
  await run(`document.querySelector('[aria-label="Expand Chroma display"]').click()`);
  await expectOutput('chroma');
  await blackout(true);
  await blackout(false);
  await expectOutput('chroma');
  await run(`document.querySelector('[aria-label="Exit Chroma presentation"]').click()`);
  await click('Back to Show');
  // Independent destinations: leave only DSM selected.
  await click('DISPLAY');
  await click('CHROMA');
  await until(async () => !(await get()).shows[0].message.destinations.display);
  assert.equal(await run(`return document.querySelectorAll('[data-output-message]').length`), 0);
  assert.equal(await run(`return document.querySelector('.workspace-message-destinations').textContent`), 'Live message · DSM');
  await click('CHROMA');
  await click('DSM');
  await until(() => run(`return document.querySelector('.workspace-message-destinations')?.textContent==='Live message · CHROMA'`));
  await click('CHROMA');
  assert.equal(await run(`return document.querySelector('${composer} [title="Toggle message"]').disabled`), true);
  await until(async () => !(await get()).shows[0].message);
  assert.equal(await run(`return !!document.querySelector('.workspace-message-destinations')`), false);
  await click('DSM');
  await wait(800);
  assert.equal((await get()).shows[0].message, undefined, 'selecting a destination while off stays local');
  await click('Show');
  await until(() => run(`return document.querySelector('.workspace-message-destinations')?.textContent==='Live message · DSM'`));
  await click('Open Chroma mode');
  assert.equal(await run(`return document.querySelectorAll('[data-output-message]').length`), 0);
  await click('Back to Show');
  await click('Preview display');
  assert.equal(await run(`return document.querySelectorAll('[data-output-message]').length`), 0);
  await click('Back to Show');
  await command('POST', `${prefix}/url`, {url: `${base}/#/dsm/messages`});
  await expectOutput('dsm');
  const beforeBlackout = await get();
  await save({...beforeBlackout, shows: beforeBlackout.shows.map(s => ({...s, blackout: true})), timerCommands: []});
  await until(() => run(`return !!document.querySelector('[aria-label="Blackout active"]')`));
  assert.equal(await run(`return document.querySelectorAll('[data-output-message]').length`), 0);
  const blacked = await get();
  await save({...blacked, shows: blacked.shows.map(s => ({...s, blackout: false})), timerCommands: []});
  await expectOutput('dsm');
  await command('POST', `${prefix}/url`, {url: `${base}/#/control/messages`});
  await until(() => run(`return !!document.querySelector('${composer}')`));
  await field('[aria-label="Message text"]', ' \n ', true);
  assert.equal(await run(`return document.querySelector('${composer} [title="Toggle message"]').matches(':disabled')`), true);
  await until(async () => !(await get()).shows[0].message);
  await click('Clear message and draft');
  await until(async () => !(await get()).shows[0].message);
  assert.equal(await run(`return document.querySelector('[aria-label="Message text"]').value`), '');
  assert.deepEqual(await run(`return [...document.querySelectorAll('[aria-label="Message destinations"] button')].map(b=>b.getAttribute('aria-pressed'))`), ['true', 'false', 'false']);
  assert.deepEqual((await get()).timerVersions, initial.timerVersions);
  await click('← All Shows');
  await run(`document.querySelector('[aria-label="Open Other show"]').click()`);
  await until(() => run(`return document.querySelector('[aria-label="Message text"]')?.value==='Other draft'`));
  await click('← All Shows');
  await run(`document.querySelector('[aria-label="Open Message show"]').click()`);
  await until(() => run(`return document.querySelector('[aria-label="Message text"]')?.value===''`));
  await command('POST', `${prefix}/refresh`, {});
  await until(() => run(`return !!document.querySelector('${composer}')`));
  await field('[aria-label="Message text"]', 'No destinations', true);
  // Reload initialized the default DISPLAY destination.
  await click('DISPLAY');
  assert.equal(await run(`return document.querySelector('${composer} [title="Toggle message"]').matches(':disabled')`), true);
  await click('DSM');
  await click('Custom');
  await field('[aria-label="Custom message color"]', '#123abc');
  await click('Show');
  await until(async () => (await get()).shows[0].message?.text === 'No destinations');
  await apiAction(base, 'configure', '2468');
  await until(() => run(`return document.querySelector('${composer} textarea')?.matches(':disabled')`));
  assert.equal(await run(`return [...document.querySelectorAll('${composer} button, ${composer} input, ${composer} textarea')].every(n=>n.matches(':disabled'))`), true);
  const lockedState = await get();
  await field('[aria-label="Message text"]', 'Locked synthetic edit', true);
  await field('[aria-label="Custom message color"]', '#abcdef');
  await run(`document.querySelectorAll('${composer} button').forEach(button=>button.click())`);
  await wait(900);
  assert.deepEqual((await get()).shows[0].message, lockedState.shows[0].message);
  assert.equal((await get()).revision, lockedState.revision, 'locked controls cannot write');
  await apiAction(base, 'configure', '');
  await until(() => run(`return !document.querySelector('${composer} textarea')?.matches(':disabled')`));
  await click('Clear message and draft');
  await until(async () => !(await get()).shows[0].message);
  assert.equal(await run(`return document.querySelector('[aria-label="Message text"]').value`), '');
  assert.equal(await run(`return document.querySelector('${composer} [title="Toggle message"]').getAttribute('aria-pressed')`), 'false');
});
