export const cueType = show => show.cues.find(cue => cue.id === show.active)?.type ?? 'countdown';
export const modeLabel = type => ({countdown: 'Countdown', countup: 'Count-up Timer', clock: 'Local Time'})[type];
// Reuse the persisted clock column: countdown deadline or count-up zero origin.
export function clockAnchor(show, now = Date.now()) {
  return now + (cueType(show) === 'countup' ? -1 : 1) * show.left * 1000;
}
export function projectTimer(show, anchor, now = Date.now()) {
  if (show.status !== 'Running' || cueType(show) === 'clock') return;
  const up = cueType(show) === 'countup';
  show.left = Math.max(0, up ? Math.floor((now - anchor) / 1000) : Math.ceil((anchor - now) / 1000));
  if (!up && !show.left) show.status = 'Complete';
}
export function formatTimer(show, now = new Date()) {
  if (cueType(show) === 'clock') {
    const twelve = show.cues.find(cue => cue.id === show.active)?.clockFormat === '12h';
    const hours = now.getHours();
    const time = [twelve ? hours % 12 || 12 : hours, now.getMinutes(), now.getSeconds()]
      .map(value => String(value).padStart(2, '0')).join(':');
    return time + (twelve ? hours >= 12 ? ' PM' : ' AM' : '');
  }
  const seconds = Math.max(0, Math.floor(show.left));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
