export const FONT_FIELDS = ['timerFont', 'textFont'];
export const MAX_FONT_BYTES = 512 * 1024;
const MAX_EXPANDED = 8 * 1024 * 1024;

export function fontBytes(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_FONT_BYTES / 3) * 4 + 40) return null;
  const match = /^data:font\/(woff2?|ttf|otf);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match || match[0] !== data) return null;
  try {
    const raw = atob(match[2]);
    if (btoa(raw) !== match[2] || raw.length > MAX_FONT_BYTES) return null;
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer), size = bytes.length;
    if (size < 12) return null;
    const u16 = offset => view.getUint16(offset), u32 = offset => view.getUint32(offset);
    const signature = u32(0), sfnt = value => value === 0x00010000 || value === 0x4f54544f;
    if (match[1] === 'ttf' || match[1] === 'otf') {
      if (signature !== (match[1] === 'ttf' ? 0x00010000 : 0x4f54544f)) return null;
      const count = u16(4), end = 12 + count * 16;
      if (!count || count > 256 || end > size) return null;
      for (let i = 12; i < end; i += 16) {
        const offset = u32(i + 8), length = u32(i + 12);
        if (offset < end || offset > size || length > size - offset) return null;
      }
    } else {
      const woff2 = match[1] === 'woff2', header = woff2 ? 48 : 44;
      if (size < header || signature !== (woff2 ? 0x774f4632 : 0x774f4646) ||
          !sfnt(u32(4)) || u32(8) !== size || !u16(12) || u16(12) > 256 || u16(14) ||
          u32(16) < 12 + u16(12) * 16 || u32(16) > MAX_EXPANDED) return null;
      if (woff2) {
        if (size <= header + u16(12) || !u32(20) || u32(20) > size - header) return null;
      } else {
        const end = header + u16(12) * 20;
        if (end > size) return null;
        let expanded = 12 + u16(12) * 16;
        for (let i = header; i < end; i += 20) {
          const offset = u32(i + 4), compressed = u32(i + 8), original = u32(i + 12);
          if (offset < end || offset > size || compressed > size - offset || compressed > original) return null;
          expanded += Math.ceil(original / 4) * 4;
        }
        if (expanded !== u32(16)) return null;
      }
      for (const offset of (woff2 ? [28, 40] : [24, 36])) {
        const start = u32(offset), length = u32(offset + 4);
        if ((start === 0) !== (length === 0) || (start && start < header) || start > size || length > size - start) return null;
      }
      if (u32(woff2 ? 36 : 32) > MAX_EXPANDED) return null;
    }
    return bytes;
  } catch { return null; }
}

export function isFont(value) {
  return value === null || (value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && typeof value.name === 'string' &&
    value.name.length > 0 && value.name.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value.name) &&
    fontBytes(value.data) !== null);
}

export async function readFont(file) {
  const format = /\.((?:woff2?|ttf|otf))$/i.exec(file.name)?.[1].toLowerCase();
  if (!format || !file.size || file.size > MAX_FONT_BYTES) throw new Error('Choose a WOFF, WOFF2, TTF, or OTF font up to 512 KiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  const font = { name: file.name, data: `data:font/${format};base64,${btoa(raw)}` };
  if (!isFont(font)) throw new Error('Invalid font header, size, or filename (maximum 255 characters).');
  if (typeof FontFace === 'undefined') throw new Error('This browser does not support uploaded fonts.');
  try { await new FontFace('UploadValidation', bytes).load(); }
  catch { throw new Error('This font could not be decoded by your browser.'); }
  return font;
}
