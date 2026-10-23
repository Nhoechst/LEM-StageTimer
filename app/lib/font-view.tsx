import { useEffect, useState } from 'react';
import { fontBytes } from './fonts.js';
import type { Show } from '../data';

let sequence = 0;
const loaded = new Map<string, { face: FontFace; family: string; users: number; ready: Promise<FontFace> }>();
export function useShowFont(show: Show, role: 'timerFont' | 'textFont') {
  const data = show[role]?.data, id = show.id;
  const [active, setActive] = useState<{ data: string; id: string; family: string } | null>(null);
  useEffect(() => {
    if (!data || typeof FontFace === 'undefined') return;
    const fonts = document.fonts as FontFaceSet & { add(face: FontFace): FontFaceSet; delete(face: FontFace): boolean };
    const key = `${id}:${role}:${data}`;
    let entry = loaded.get(key);
    if (!entry) {
      const bytes = fontBytes(data);
      if (!bytes) return;
      const family = `ShowFont${++sequence}`;
      const face = new FontFace(family, bytes);
      entry = { face, family, users: 0, ready: face.load() };
      loaded.set(key, entry);
    }
    const resource = entry;
    resource.users++;
    let alive = true;
    resource.ready.then(() => {
      if (alive) {
        fonts.add(resource.face);
        setActive({ data, id, family: resource.family });
      }
    }).catch(() => { /* Keep the built-in font if the browser rejects the font. */ });
    return () => {
      alive = false;
      if (--resource.users === 0) {
        fonts.delete(resource.face);
        loaded.delete(key);
      }
    };
  }, [data, id, role]);
  return active?.data === data && active?.id === id
    ? { fontFamily: `${active.family}, ${role === 'timerFont' ? 'ui-monospace, monospace' : 'ui-sans-serif, system-ui, sans-serif'}` }
    : undefined;
}
