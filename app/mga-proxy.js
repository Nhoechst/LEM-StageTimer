
let _reqId = 0;
const _pending = new Map();

window.addEventListener('message', (e) => {
  if (e.data?.type !== 'mga-fetch-response') return;
  const p = _pending.get(e.data.id);
  if (!p) return;
  _pending.delete(e.data.id);
  if (e.data.error) p.reject(new Error(e.data.error));
  else p.resolve(new Response(e.data.body, {
    status: e.data.status,
    statusText: e.data.statusText,
    headers: e.data.headers,
  }));
});

export function proxyFetch(url, options = {}) {
  const id = ++_reqId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { _pending.delete(id); reject(new Error('Proxy fetch timeout')); }, 120000);
    _pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    // Determine the parent origin as precisely as possible so the postMessage
    // target is never the wildcard '*', which would expose request metadata
    // (URL, method, headers) to any listening cross-origin frame.
    //
    // Priority order:
    //  1. REACT_APP_API_ROOT_URL injected by sandpackEnvBridge — always present
    //     in production; derive the origin from it (works on all browsers).
    //     Wrapped in try/catch: new URL() throws on malformed values (e.g. the
    //     bare string 'api' that results when NEXT_PUBLIC_BACKEND_URL_V3 is
    //     missing in local dev), which would otherwise crash proxyFetch entirely.
    //  2. ancestorOrigins[0] — Chromium-only fallback (undefined in Firefox/Safari).
    //  3. '*' — last-resort fallback for local dev without the env var.
    const _parentOrigin = (() => {
      try {
        const envUrl = typeof process !== 'undefined' && process.env.REACT_APP_API_ROOT_URL;
        if (envUrl) return new URL(envUrl).origin;
      } catch { /* malformed URL — fall through */ }
      return window.location.ancestorOrigins?.[0] ?? '*';
    })();
    window.parent.postMessage({
      type: 'mga-fetch-request',
      id,
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || null,
    }, _parentOrigin);
  });
}
