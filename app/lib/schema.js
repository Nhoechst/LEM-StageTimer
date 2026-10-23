import { DESIGN_IDS, isLogo, isInheritedLogo, sameTemplateName, LOGO_FIELDS, LOGO_NAME_FIELDS, HEADER_LOGO_FIELDS, HEADER_LOGO_NAME_FIELDS } from './branding.js';
import { FONT_FIELDS, isFont } from './fonts.js';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isId = value => typeof value === 'string' && value.trim().length > 0;
const optional = (value, key, check) => value[key] === undefined || check(value[key]);
const isString = value => typeof value === 'string';
const isBoolean = value => typeof value === 'boolean';

export function isShow(value) {
  if (!isRecord(value) || !FONT_FIELDS.every(key => optional(value, key, isFont))) return false;
  if (!isRecord(value) || !isId(value.id) || !isString(value.title) ||
      !Array.isArray(value.cues) || !isTime(value.left) ||
      !['Ready', 'Running', 'Paused', 'Complete'].includes(value.status) ||
      !isString(value.templateId) || !isBoolean(value.logoOn)) return false;
  const ids = new Set();
  for (const cue of value.cues) {
    if (!isRecord(cue) || !isId(cue.id) || ids.has(cue.id) ||
        !isString(cue.name) || !isTime(cue.duration) ||
        !optional(cue, 'type', type => ['countdown', 'countup', 'clock'].includes(type)) ||
        !optional(cue, 'clockFormat', format => ['12h', '24h'].includes(format))) return false;
    ids.add(cue.id);
  }
  for (const key of ['active', 'uploadedLogo', 'logoName']) {
    if (!optional(value, key, isString)) return false;
  }
  if (!LOGO_FIELDS.slice(1).every(key => optional(value, key, image => isLogo(image) ||
        (key === 'uploadedLogoLight' && isInheritedLogo(image, value.uploadedLogo)))) ||
      !LOGO_NAME_FIELDS.slice(1).every(key => optional(value, key, text => isString(text) &&
        (text.length <= 255 || (key === 'logoNameLight' && text === value.logoName))))) return false;
  if (!optional(value, 'blackout', isBoolean) || !optional(value, 'pinnedAt', isTime)) return false;
  if (value.message !== undefined) {
    const message = value.message;
    if (!isRecord(message) || !isString(message.text) ||
        !isRecord(message.destinations) || !isBoolean(message.destinations.display) ||
        !isBoolean(message.destinations.dsm) || !optional(message.destinations, 'chroma', isBoolean) ||
        !optional(message, 'color', color => isString(color) && color.length === 7 && /^#[0-9a-f]{6}$/i.test(color)) ||
        !optional(message, 'flash', isBoolean) || !optional(message, 'bold', isBoolean) ||
        !optional(message, 'uppercase', isBoolean)) return false;
    // Old state allowed arbitrary strings and no destinations; keep it readable and saveable.
    const extended = 'color' in message || 'flash' in message || 'bold' in message ||
      'uppercase' in message || 'chroma' in message.destinations;
    if (extended && (message.text.length > 500 || !message.text.trim() ||
        !['display', 'dsm', 'chroma'].some(key => message.destinations[key] === true))) return false;
  }
  return true;
}

export function isStatePayload(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Array.isArray(value.shows) || !value.shows.every(isShow) ||
      !isRecord(value.settings) || !isString(value.settings.pin) ||
      !/^(?:|\d{4,6})$/.test(value.settings.pin)) return false;
  if (!['mainHeader', 'subHeader'].every(key => optional(value.settings, key, text => isString(text) && text.length <= 200)) ||
      !HEADER_LOGO_FIELDS.every(key => optional(value.settings, key, isLogo)) ||
      !HEADER_LOGO_NAME_FIELDS.every(key => optional(value.settings, key, text => isString(text) && text.length <= 255))) return false;
  if (value.templates !== undefined) {
    if (!Array.isArray(value.templates) || value.templates.length > 50 ||
        !value.templates.every(template => isRecord(template) && isId(template.id) &&
          isString(template.name) && template.name === template.name.trim() &&
          template.name.length > 0 && template.name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(template.name) &&
          DESIGN_IDS.includes(template.templateId) && isBoolean(template.logoOn) &&
          LOGO_FIELDS.every(key => optional(template, key, isLogo)) &&
          LOGO_NAME_FIELDS.every(key => optional(template, key, text => isString(text) && text.length <= 255)) &&
          FONT_FIELDS.every(key => optional(template, key, isFont)) &&
          Object.keys(template).every(key => ['id', 'name', 'templateId', 'logoOn', ...LOGO_FIELDS, ...LOGO_NAME_FIELDS, ...FONT_FIELDS].includes(key)))) return false;
    if (new Set(value.templates.map(template => template.id)).size !== value.templates.length ||
        value.templates.some((template, index) => value.templates.slice(0, index).some(previous => sameTemplateName(template.name, previous.name)))) return false;
  }
  return new Set(value.shows.map(show => show.id)).size === value.shows.length;
}
