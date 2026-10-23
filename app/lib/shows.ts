import type { Show } from '../data';
import { isShow } from './schema.js';

export function readShows(fallback: Show[]): Show[] {
  try {
    const saved = localStorage.getItem('bayer-mock-shows');
    if (saved === null) return fallback;
    const parsed: unknown = JSON.parse(saved);
    const ids = new Set<string>();
    const valid = Array.isArray(parsed) ? parsed.filter((show): show is Show => {
      if (!isShow(show) || ids.has(show.id)) return false;
      ids.add(show.id);
      return true;
    }) : [];
    if (!Array.isArray(parsed) || valid.length !== parsed.length) {
      return valid.length ? valid : fallback;
    }
    return valid;
  } catch {
    return fallback;
  }
}
