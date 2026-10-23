// Coordinate only cookie establishment, never timer/state requests. The fallback
// stores a short-lived, non-secret mutex, not a PIN or session credential.
async function cookieLock<T>(job: () => Promise<T>): Promise<T> {
  if (navigator.locks) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 25000);
    try { return await navigator.locks.request('lem-time-cookie-bootstrap', { signal: controller.signal }, job); }
    finally { window.clearTimeout(timeout); }
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lem-time-operator-bootstrap', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('locks');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Browser storage is needed to authorize operator windows safely.'));
  });
  const owner = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
  const lease = (release = false) => new Promise<boolean>((resolve, reject) => {
    const transaction = db.transaction('locks', 'readwrite');
    const store = transaction.objectStore('locks');
    const request = store.get('cookie');
    let acquired = false;
    request.onsuccess = () => {
      const previous = request.result;
      if (release) {
        if (previous?.owner === owner) store.delete('cookie');
      } else if (!previous || previous.expires <= Date.now()) {
        acquired = true;
        store.put({ owner, expires: Date.now() + 20000 }, 'cookie');
      }
    };
    transaction.oncomplete = () => resolve(acquired);
    transaction.onerror = transaction.onabort = () => reject(new Error('Unable to coordinate operator authorization.'));
  });
  try {
    const deadline = Date.now() + 25000;
    while (!await lease()) {
      if (Date.now() > deadline) throw new Error('Another window is authorizing. Please retry.');
      await new Promise(resolve => window.setTimeout(resolve, 50));
    }
    try { return await job(); } finally { await lease(true); }
  } finally { db.close(); }
}

export function establishOperatorCookie(api: string, headers: Record<string, string>) {
  return cookieLock(async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(api, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bootstrap' }), signal: controller.signal,
      });
      if (!response.ok) throw new Error('Unable to establish a private operator session.');
    } finally { window.clearTimeout(timeout); }
  });
}
