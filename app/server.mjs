import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { constants, lstatSync, openSync, closeSync, readFileSync, renameSync, rmSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStatePayload } from './lib/schema.js';
import { normalizeBrandingState, normalizeLogo } from './lib/branding.js';
import { clockAnchor, projectTimer } from './lib/timer.js';
import { operatorAuth, hashPin } from './lib/operator-auth.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 10 * 1024 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function createStore(dbPath = process.env.DB_PATH || path.join(ROOT, 'lem-time.db')) {
  const filename = path.resolve(dbPath);
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  for (const file of [filename, `${filename}.bak`, `${filename}.bak-next`]) {
    if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Database files must not be symlinks.');
  }
  if (!existsSync(filename) && existsSync(`${filename}.bak`)) throw new Error('Restore the database backup before continuing.');
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL, initialized INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO meta VALUES (1, 0, 0);
      CREATE TABLE IF NOT EXISTS shows (
        id TEXT PRIMARY KEY, position INTEGER NOT NULL, metadata TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cues (
        show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
        id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (show_id, id)
      );
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), pin TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES (1, '');
      CREATE TABLE IF NOT EXISTS site_settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
      INSERT OR IGNORE INTO site_settings VALUES (1, '{}');
      CREATE TABLE IF NOT EXISTS branding_templates (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS timer_clock (
        show_id TEXT PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE, deadline REAL NOT NULL
      );
    `);
    db.exec('BEGIN IMMEDIATE');
    const seedClock = db.prepare('INSERT OR IGNORE INTO timer_clock VALUES (?, ?)');
    for (const row of db.prepare('SELECT id, metadata FROM shows').all()) {
      const show = JSON.parse(row.metadata);
      if (show.status === 'Running') {
        show.cues = db.prepare('SELECT data FROM cues WHERE show_id = ?').all(row.id).map(cue => JSON.parse(cue.data));
        seedClock.run(row.id, clockAnchor(show));
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    throw error;
  }
  const read = () => {
    const meta = db.prepare('SELECT revision, initialized FROM meta WHERE id = 1').get();
    if (!meta.initialized) return { initialized: false, revision: meta.revision };
    const shows = db.prepare('SELECT id, metadata FROM shows ORDER BY position').all().map(row => ({
      ...JSON.parse(row.metadata),
      cues: db.prepare('SELECT data FROM cues WHERE show_id = ? ORDER BY position').all(row.id)
        .map(cue => JSON.parse(cue.data)),
    }));
    const timerVersions = {};
    for (const show of shows) {
      const clock = db.prepare('SELECT deadline FROM timer_clock WHERE show_id = ?').get(show.id);
      timerVersions[show.id] = [show.active ?? null, show.left, show.status, clock?.deadline ?? null];
      // Project one persisted server clock; reads never tick or bump revisions.
      if (clock && show.status === 'Running') {
        projectTimer(show, clock.deadline);
      }
    }
    return normalizeBrandingState({
      initialized: true, revision: meta.revision, shows, timerVersions,
      settings: { ...JSON.parse(db.prepare('SELECT data FROM site_settings WHERE id = 1').get().data),
        pin: '' },
      templates: db.prepare('SELECT data FROM branding_templates ORDER BY position').all().map(row => JSON.parse(row.data)),
    });
  };
  const auth = operatorAuth(db, (status, message) => { throw new HttpError(status, message); });
  let importRevision;
  const store = {
    filename,
    getState() {
      db.exec('BEGIN');
      try {
        const state = read();
        db.exec('COMMIT');
        return state;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    auth,
    saveState(payload, operator) {
      if (!isStatePayload(payload)) throw new HttpError(400, 'Invalid state payload.');
      if (payload.timerCommands !== undefined && (!Array.isArray(payload.timerCommands) ||
          payload.timerCommands.some(id => typeof id !== 'string'))) {
        throw new HttpError(400, 'Invalid timer commands.');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (operator && !auth.status(operator.id, operator.token).authorized) throw new HttpError(401, 'Enter the PIN to authorize this window.');
        const { revision } = db.prepare('SELECT revision FROM meta WHERE id = 1').get();
        if (payload.revision !== revision) {
          throw new HttpError(409, 'State changed. Reload before saving.', { revision });
        }
        if (revision === Number.MAX_SAFE_INTEGER) throw new HttpError(409, 'Revision limit reached.');
        const previousShows = new Map(db.prepare('SELECT id, metadata FROM shows').all()
          .map(row => [row.id, JSON.parse(row.metadata)]));
        const clocks = new Map(db.prepare('SELECT show_id, deadline FROM timer_clock').all()
          .map(row => [row.show_id, row.deadline]));
        // A separate read connection snapshots the committed state while this writer holds its lock.
        const staging = `${filename}.bak-next`;
        let backupDb;
        try {
          for (const file of [staging, `${filename}.bak`]) {
            if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Database backups must not be symlinks.');
          }
          rmSync(staging, { force: true });
          backupDb = new DatabaseSync(filename, { readOnly: true });
          backupDb.prepare('VACUUM INTO ?').run(staging);
          chmodSync(staging, 0o600);
          backupDb.close();
          backupDb = undefined;
          renameSync(staging, `${filename}.bak`);
        } finally {
          backupDb?.close();
          rmSync(staging, { force: true });
        }
        db.exec('DELETE FROM cues; DELETE FROM shows;');
        const insertShow = db.prepare('INSERT INTO shows (id, position, metadata) VALUES (?, ?, ?)');
        const insertCue = db.prepare('INSERT INTO cues (show_id, id, position, data) VALUES (?, ?, ?, ?)');
        payload.shows.forEach(({ cues, ...metadata }, position) => {
          const previous = previousShows.get(metadata.id);
          metadata = normalizeLogo(metadata, 'uploadedLogo', 'logoName', previous && normalizeLogo(previous));
          const command = !previous || payload.timerCommands === undefined || payload.timerCommands.includes(metadata.id);
          if (!command) {
            for (const key of ['active', 'left', 'status']) {
              if (previous[key] === undefined) delete metadata[key];
              else metadata[key] = previous[key];
            }
          }
          insertShow.run(metadata.id, position, JSON.stringify(metadata));
          if (metadata.status === 'Running') {
            db.prepare('INSERT INTO timer_clock VALUES (?, ?)').run(metadata.id,
              command ? clockAnchor({ ...metadata, cues }) : clocks.get(metadata.id));
          }
          cues.forEach((cue, cuePosition) => {
            insertCue.run(metadata.id, cue.id, cuePosition, JSON.stringify(cue));
          });
        });
        if (payload.settings.pin) db.prepare('UPDATE settings SET pin = ? WHERE id = 1').run(hashPin(payload.settings.pin));
        const site = normalizeLogo(JSON.parse(db.prepare('SELECT data FROM site_settings WHERE id = 1').get().data), 'headerLogo', 'headerLogoName');
        const incoming = normalizeLogo(payload.settings, 'headerLogo', 'headerLogoName', site);
        for (const key of ['mainHeader', 'subHeader', 'headerLogo', 'headerLogoName', 'headerLogoLight', 'headerLogoDark', 'headerLogoNameLight', 'headerLogoNameDark']) {
          if (incoming[key] !== undefined) site[key] = incoming[key];
        }
        db.prepare('UPDATE site_settings SET data = ? WHERE id = 1').run(JSON.stringify(site));
        if (payload.templates !== undefined) {
          const previousTemplates = new Map(db.prepare('SELECT id, data FROM branding_templates').all()
            .map(row => [row.id, normalizeLogo(JSON.parse(row.data))]));
          db.exec('DELETE FROM branding_templates');
          const insert = db.prepare('INSERT INTO branding_templates VALUES (?, ?, ?)');
          payload.templates.forEach((template, position) => insert.run(template.id, position,
            JSON.stringify(normalizeLogo(template, 'uploadedLogo', 'logoName', previousTemplates.get(template.id)))));
        }
        db.prepare('UPDATE meta SET revision = ?, initialized = 1 WHERE id = 1').run(importRevision ?? revision + 1);
        const state = read();
        db.exec('COMMIT');
        return state;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() { db.close(); },
  };
  try {
    const legacy = process.env.STATE_PATH || path.join(path.dirname(filename), 'lem-time.json');
    if (!db.prepare('SELECT initialized FROM meta WHERE id = 1').get().initialized) {
      if (lstatSync(legacy, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('JSON import must be a regular private file.');
      if (!existsSync(legacy) && existsSync(`${legacy}.bak`)) throw new Error('Restore JSON state before importing.');
      if (existsSync(legacy)) {
        const state = JSON.parse(readFileSync(legacy, 'utf8'));
        if (typeof state.initialized !== 'boolean' ||
            (state.initialized ? !isStatePayload(state) : state.revision !== 0)) throw new Error('Invalid JSON state.');
        if (state.initialized) {
          importRevision = state.revision;
          store.saveState({ ...state, revision: 0 });
          importRevision = undefined;
        }
      }
    }
    return store;
  } catch (error) {
    db.close();
    throw error;
  }
}

function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(data), ...headers,
  });
  res.end(data);
}

function parseAppOrigin(value) {
  if (value === undefined) return null;
  try {
    const origin = new URL(value);
    if (['http:', 'https:'].includes(origin.protocol) && value === origin.origin) return origin;
  } catch {}
  throw new Error('APP_ORIGIN must be an exact normalized http(s) origin.');
}

function allowedOrigin(req, host, appOrigin) {
  try {
    const target = new URL(`http://${req.headers.host}`);
    const publicHost = appOrigin &&
      new URL(`${appOrigin.protocol}//${req.headers.host}`).host === appOrigin.host;
    if (!LOOPBACK.has(target.hostname) && target.hostname !== host && !publicHost) return false;
    if (!req.headers.origin) return null;
    const origin = new URL(req.headers.origin);
    if (req.headers.origin === appOrigin?.origin && (publicHost || LOOPBACK.has(target.hostname))) {
      return origin.origin;
    }
    if (publicHost && !LOOPBACK.has(target.hostname)) return false;
    if (origin.origin !== req.headers.origin || origin.protocol !== 'http:') return false;
    if (origin.host === target.host) return origin.origin;
    if (LOOPBACK.has(origin.hostname) && LOOPBACK.has(target.hostname) &&
        ['5173', '4173'].includes(origin.port)) return origin.origin;
  } catch {}
  return false;
}

function readPayload(req) {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json.');
  }
  if (Number(req.headers['content-length']) > MAX_BODY) {
    req.resume();
    throw new HttpError(413, 'Payload too large.');
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const onError = () => fail(new HttpError(400, 'Unable to read request.'));
    const onAborted = () => fail(new HttpError(400, 'Request aborted.'));
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY) return fail(new HttpError(413, 'Payload too large.'));
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {
        reject(new HttpError(400, 'Malformed JSON.'));
      }
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function staticFile(req, res, distDir, dbFilename) {
  let pathname;
  try {
    pathname = decodeURIComponent(req.url.split('?', 1)[0]);
  } catch {
    throw new HttpError(400, 'Invalid path.');
  }
  const segments = pathname.split('/').filter(Boolean);
  if (pathname.includes('\\') || pathname.includes('\0') ||
      segments.some(segment => segment.startsWith('.'))) throw new HttpError(404, 'Not found.');
  const root = path.resolve(distDir);
  const inspect = parts => {
    let file = root;
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return null;
    for (const part of parts) {
      file = path.join(file, part);
      if (lstatSync(file).isSymbolicLink()) return null;
    }
    if (!lstatSync(file).isFile() || !MIME[path.extname(file).toLowerCase()]) return null;
    if ([dbFilename, `${dbFilename}.bak`, `${dbFilename}.bak-next`].includes(file)) return null;
    return file;
  };
  let file;
  try { file = inspect(segments.length ? segments : ['index.html']); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
  if (!file && !path.extname(pathname) && (req.headers.accept || '').includes('text/html')) {
    try { file = inspect(['index.html']); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  if (!file) throw new HttpError(404, 'Not found.');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data;
  try { data = readFileSync(fd); } finally { closeSync(fd); }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()],
    'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

export function createServer({
  dbPath = process.env.DB_PATH || path.join(ROOT, 'lem-time.db'),
  distDir = path.join(ROOT, 'dist'),
  host = process.env.HOST || '127.0.0.1',
  appOrigin = process.env.APP_ORIGIN,
  store,
} = {}) {
  const publicOrigin = parseAppOrigin(appOrigin);
  store ??= createStore(dbPath);
  const server = http.createServer(async (req, res) => {
    req.on('error', () => {});
    try {
      let pathname;
      try { pathname = decodeURIComponent(req.url.split('?', 1)[0]); } catch {
        throw new HttpError(400, 'Invalid path.');
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const origin = allowedOrigin(req, host, publicOrigin);
        if (origin === false) throw new HttpError(403, 'Origin not allowed.');
        if (origin) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
        if (pathname !== '/api/state') throw new HttpError(404, 'API endpoint not found.');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Operator-ID', 'Cache-Control': 'no-store',
          });
          res.end();
        } else {
          const id = /^[a-f0-9]{32}$/.test(req.headers['x-operator-id'] ?? '') ? req.headers['x-operator-id'] : '';
          const cookieName = 'lem_operator';
          const suppliedToken = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
          const token = /^[a-f0-9]{64}$/.test(suppliedToken) ? suppliedToken : randomBytes(32).toString('hex');
          const secure = publicOrigin?.protocol === 'https:' || !!req.socket.encrypted;
          const setCookie = value => res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`);
          const operator = { id, token };
          if (req.method === 'POST') {
            const result = store.auth.action(await readPayload(req), id, token, req.socket.remoteAddress ?? '');
            if (result.token !== suppliedToken) setCookie(result.token);
            json(res, 200, { auth: result.auth });
          } else if (req.method === 'GET') {
            json(res, 200, { ...store.getState(), auth: store.auth.status(id, token) });
          } else if (req.method === 'PUT') {
            if (!store.auth.status(id, token).authorized) throw new HttpError(401, 'Enter the PIN to authorize this window.');
            const payload = await readPayload(req);
            if (payload?.settings?.pin !== '') throw new HttpError(400, 'Use operator PIN configuration instead.');
            json(res, 200, { ...store.saveState(payload, operator), auth: store.auth.status(id, token) });
          } else {
            json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PUT, POST, OPTIONS' });
          }
        }
      } else {
        if (!['GET', 'HEAD'].includes(req.method)) {
          throw new HttpError(405, 'Method not allowed.');
        }
        staticFile(req, res, distDir, store.filename);
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        json(res, error instanceof HttpError ? error.status : 500, {
          error: error instanceof HttpError ? error.message : 'Unable to complete request.',
          ...(error instanceof HttpError ? error.extra : {}),
        });
      } else if (!res.destroyed) res.end();
    }
  });
  server.on('close', () => store.close());
  server.store = store;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3001);
  try {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    const server = createServer({ host });
    server.on('error', () => {
      console.error('Unable to start LEM-Time backend.');
      server.store.close();
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      console.log(`LEM-Time backend listening on http://${host}:${server.address().port}`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => server.close());
    }
  } catch {
    console.error('Unable to start LEM-Time backend.');
    process.exitCode = 1;
  }
}
