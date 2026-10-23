import { normalizeBrandingState, sameTemplateName } from './branding.js';
export function serialize(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
}
const equal = (a, b) => serialize(a) === serialize(b);
const runtime = show => [show.active, show.left, show.status,
  show.cues.find(cue => cue.id === show.active)?.type ?? 'countdown',
  show.cues.find(cue => cue.id === show.active)?.duration];

export function timerCommands(base, next, explicit = []) {
  return next.shows.filter(show => {
    const previous = base.shows.find(item => item.id === show.id);
    return explicit.includes(show.id) || !previous || !equal(runtime(previous), runtime(show));
  }).map(show => show.id);
}

// Arrays other than shows are atomic: concurrent cue reordering must not be lost.
export function mergeState(base, local, remote, baseVersions, remoteVersions, explicit = []) {
  [base, local, remote] = [base, local, remote].map(normalizeBrandingState);
  if (baseVersions && remoteVersions) {
    for (const id of timerCommands(base, local, explicit)) {
      if (!equal(baseVersions[id], remoteVersions[id])) {
        throw new Error('Timer controls were edited in another window. Reload before changing that timer.');
      }
    }
  }
  for (const id of timerCommands(base, local, explicit)) {
    const b = base.shows.find(show => show.id === id);
    const r = remote.shows.find(show => show.id === id);
    if (!b && !explicit.includes(id)) continue;
    if (!b || !r || b.active !== r.active ||
        !equal(b.cues.find(cue => cue.id === b.active), r.cues.find(cue => cue.id === r.active))) {
      throw new Error('Concurrent edits overlap: the active cue changed in another window. Reload before changing that timer.');
    }
  }
  function merge(b, l, r, key) {
    if (equal(l, b)) return r;
    if (equal(r, b) || equal(l, r)) return l;
    if (key !== 'message' && b && l && r && !Array.isArray(b) &&
        typeof b === 'object' && typeof l === 'object' && typeof r === 'object') {
      const result = {};
      for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        result[key] = merge(b[key], l[key], r[key], key);
      }
      return result;
    }
    throw new Error('Concurrent edits overlap. Download your changes or reload saved data.');
  }
  const order = merge(base.shows.map(s => s.id), local.shows.map(s => s.id), remote.shows.map(s => s.id));
  const strip = ({ active, left, status, ...rest }) => rest;
  const mergedShows = new Map(
    [...new Set([...base.shows, ...local.shows, ...remote.shows].map(show => show.id))].map(id => {
      const b = base.shows.find(s => s.id === id);
      const l = local.shows.find(s => s.id === id);
      const r = remote.shows.find(s => s.id === id);
      if (b && !l && r && equal(strip(b), strip(r)) &&
          (!baseVersions || equal(baseVersions[id], remoteVersions?.[id]))) {
        return [id, undefined];
      }
      if (!b || !l || !r) return [id, merge(b, l, r)];
      const result = merge(strip(b), strip(l), strip(r));
      // A locally queued timer command wins over elapsed server time, not edits.
      const timer = !explicit.includes(id) && equal(runtime(b), runtime(l)) ? r : l;
      return [id, { ...result, active: timer.active, left: timer.left, status: timer.status }];
    }));
  // Template snapshots are atomic, but independent additions merge by stable ID.
  const templates = [];
  for (const id of new Set([...(base.templates || []), ...(local.templates || []), ...(remote.templates || [])].map(t => t.id))) {
    const find = data => (data.templates || []).find(t => t.id === id);
    const b = find(base), l = find(local), r = find(remote);
    if (!equal(l, b) && !equal(r, b) && !equal(l, r)) {
      throw new Error('Concurrent template edits overlap. Reload before changing this template.');
    }
    const template = equal(l, b) ? r : l;
    if (template) templates.push(template);
  }
  if (templates.length > 50 || templates.some((template, index) => templates.slice(0, index).some(previous => sameTemplateName(template.name, previous.name)))) {
    throw new Error('Concurrent template names overlap. Reload and choose a different name.');
  }
  return {
    ...(base.templates || local.templates || remote.templates ? { templates } : {}),
    settings: merge(base.settings, local.settings, remote.settings),
    shows: order.map(id => mergedShows.get(id)),
  };
}
