export function showLink(href, view, id) {
  const url = new URL(href);
  url.hash = `/${view}/${encodeURIComponent(id)}`;
  return url.href;
}

export function readShowLink(hash) {
  const match = /^#\/(control|display|dsm|dsm-preview|chroma)\/([^/]+)$/.exec(hash);
  if (!match) return null;
  try {
    return { view: match[1], id: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}
