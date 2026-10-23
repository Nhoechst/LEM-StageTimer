import { FONT_FIELDS } from './fonts.js';
export const DEFAULT_SETTINGS = {
  mainHeader: 'Live Event Timers',
  subHeader: 'Show operations · local timer simulation',
  headerLogo: '',
  headerLogoName: '',
  headerLogoLight: '',
  headerLogoNameLight: '',
  headerLogoDark: '',
  headerLogoNameDark: '',
};
export const DESIGN_IDS = ['bayer-light', 'bayer-blue', 'minimal-dark'];
export const LOGO_FIELDS = ['uploadedLogo', 'uploadedLogoLight', 'uploadedLogoDark'];
export const LOGO_NAME_FIELDS = ['logoName', 'logoNameLight', 'logoNameDark'];
export const HEADER_LOGO_FIELDS = ['headerLogo', 'headerLogoLight', 'headerLogoDark'];
export const HEADER_LOGO_NAME_FIELDS = ['headerLogoName', 'headerLogoNameLight', 'headerLogoNameDark'];
export const SETTING_FIELDS = ['mainHeader', 'subHeader', ...HEADER_LOGO_FIELDS, ...HEADER_LOGO_NAME_FIELDS];
export function selectLogo(mode, light, dark) {
  const candidates = mode === 'dark' ? [dark, light] : [light];
  return candidates.find(value => value && isImageDataUrl(value)) || '';
}
export function normalizeLogo(value, logo = 'uploadedLogo', name = 'logoName', previous) {
  const result = { ...value };
  if (logo === 'uploadedLogo' && previous) {
    for (const key of FONT_FIELDS) if (!(key in result) && key in previous) result[key] = previous[key];
  }
  const keys = [logo, name, `${logo}Light`, `${name}Light`, `${logo}Dark`, `${name}Dark`];
  if (!keys.some(key => key in value || (previous && key in previous))) return result;
  // Old clients omit the new slots. Preserve even an explicitly deleted default.
  for (const key of keys.slice(2)) {
    if (!(key in result) && previous && key in previous) result[key] = previous[key];
  }
  if (!result[`${logo}Light`] && result[logo] && !(previous && `${logo}Light` in previous)) {
    result[`${logo}Light`] = result[logo];
    result[`${name}Light`] = result[name] || '';
  }
  for (const key of keys.slice(2)) result[key] ||= '';
  // Keep provenance only for grandfathered show uploads that exceed today's limits.
  result[logo] = result[`${logo}Light`] && !isLogo(result[`${logo}Light`]) ? result[`${logo}Light`] : '';
  result[name] = result[`${name}Light`]?.length > 255 ? result[`${name}Light`] : '';
  return result;
}
export function normalizeBrandingState(state) {
  return { ...state, shows: state.shows.map(show => normalizeLogo(show)),
    settings: normalizeLogo(state.settings, 'headerLogo', 'headerLogoName'),
    ...(state.templates ? { templates: state.templates.map(template => normalizeLogo(template)) } : {}) };
}
export function isInheritedLogo(value, legacy) {
  // The old show field accepted any string. Keep it removable without accepting
  // unrestricted values in independent new slots; rendering still checks image URLs.
  return typeof value === 'string' && value === legacy;
}
export function displayLogo(show) {
  // The blue and neutral-dark designs both have dark logo backgrounds.
  const mode = ['bayer-blue', 'minimal-dark'].includes(show.templateId) ? 'dark' : 'light';
  const normalized = normalizeLogo(show);
  return selectLogo(mode, normalized.uploadedLogoLight, normalized.uploadedLogoDark);
}
export const MAX_LOGO_BYTES = 512 * 1024;
export function sameTemplateName(a, b) {
  return new RegExp(`^(?:${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`, 'iu').test(b);
}
export function isLogo(value) {
  return typeof value === 'string' && (value === '' ||
    (value.length <= Math.ceil(MAX_LOGO_BYTES / 3) * 4 + 64 && isImageDataUrl(value)));
}
function isImageDataUrl(value) {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
export function brandingSnapshot(show) {
  show = normalizeLogo(show);
  return { templateId: DESIGN_IDS.includes(show.templateId) ? show.templateId : DESIGN_IDS[0], logoOn: show.logoOn,
    ...Object.fromEntries([...LOGO_FIELDS, ...LOGO_NAME_FIELDS].map(key => [key, show[key] || ''])),
    ...Object.fromEntries(FONT_FIELDS.map(key => [key, show[key] ? { ...show[key] } : null])) };
}
export async function readLogo(file) {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.type) ||
      file.size > MAX_LOGO_BYTES || file.size === 0) {
    throw new Error('Choose a PNG, JPEG, WebP, or SVG image up to 512 KiB.');
  }
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Unable to read this image.'));
    reader.readAsDataURL(file);
  });
  await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 8192 || image.naturalHeight > 8192) {
        reject(new Error('Logo dimensions must be between 1 and 8192 pixels.'));
      } else resolve();
    };
    image.onerror = () => reject(new Error('This file is not a readable image.'));
    image.src = url;
  });
  return url;
}
