export function remainingSeconds(minutes, seconds) {
  if (!/^\d+$/.test(minutes) || !/^\d+$/.test(seconds)) return null;
  const m = Number(minutes), s = Number(seconds);
  const total = m * 60 + s;
  return Number.isSafeInteger(m) && Number.isSafeInteger(s) && s <= 59 &&
    Number.isSafeInteger(total) && total > 0 ? total : null;
}
