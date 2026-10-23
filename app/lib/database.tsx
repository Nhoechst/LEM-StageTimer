import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { Show } from '../data';
import { INITIAL_SHOWS } from '../data';
import { readShows } from './shows';
import { isStatePayload } from './schema.js';
import { readShowLink } from './show-links.js';
import { mergeState, serialize, timerCommands } from './sync.js';
import type { SiteSettings, SavedTemplate } from './branding';
import { establishOperatorCookie } from './operator-cookie';
import { normalizeBrandingState } from './branding.js';

type Data = { shows: Show[]; settings: SiteSettings; templates?: SavedTemplate[] };
type DatabaseContextValue = {
  shows: Show[];
  setShows: Dispatch<SetStateAction<Show[]>>;
  pin: string;
  authorized: boolean;
  operatorAction: (action: 'unlock' | 'lock' | 'configure', pin?: string) => Promise<void>;
  settings: SiteSettings;
  setSettings: Dispatch<SetStateAction<SiteSettings>>;
  templates: SavedTemplate[];
  setTemplates: Dispatch<SetStateAction<SavedTemplate[]>>;
  status: string;
  setReadOnly: (value: boolean) => void;
  timerVersion: (id: string) => string;
  setRemainingTime: (expected: Show, version: string, seconds: number) => string;
};
const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function useDatabase() {
  const value = useContext(DatabaseContext);
  if (!value) throw new Error('Database provider is missing');
  return value;
}

export function DatabaseStatus() {
  const { status } = useDatabase();
  return status ? <span role="status" className="text-xs text-slate-500">{status}</span> : null;
}

class DatabaseError extends Error {
  constructor(message: string, public conflict = false, public unauthorized = false) {
    super(message);
  }
}

// A fresh identifier per document keeps even duplicated tabs independent. It is not a credential.
const operatorId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => ('0' + byte.toString(16)).slice(-2)).join('');
const operatorHeaders = { 'X-Operator-ID': operatorId };
const stateApi = import.meta.env.VITE_STATE_API;

async function requestState(payload?: Data & { revision: number; timerCommands?: string[] }) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(stateApi, {
      method: payload ? 'PUT' : 'GET',
      headers: { ...operatorHeaders, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      credentials: 'same-origin',
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
    if (response.status === 409) {
      throw new DatabaseError('The database changed in another window. Reload to use the latest saved data.', true);
    }
    if (response.status === 401) throw new DatabaseError('Enter the PIN to authorize this window.', false, true);
    if (!response.ok) throw new DatabaseError(`Database request failed (${response.status}). Check that the backend is running and its data folder is writable.`);
    const result = await response.json();
    if (!Number.isSafeInteger(result.revision) || result.revision < 0 ||
        typeof result.initialized !== 'boolean' ||
        (result.initialized && !isStatePayload(result))) {
      throw new DatabaseError('The database returned invalid data. Your browser data has not been cleared.');
    }
    return (result.initialized ? normalizeBrandingState(result) : result) as Data & { initialized: boolean; revision: number; timerVersions?: Record<string, unknown>; auth: { configured: boolean; authorized: boolean } };
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError('Cannot connect to the database. Check the backend and its writable data folder, then retry.');
  } finally {
    window.clearTimeout(timeout);
  }
}

function migrationData(): Data {
  return normalizeBrandingState({ shows: readShows(INITIAL_SHOWS), settings: { pin: '' } });
}

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Data>({ shows: [], settings: { pin: '' } });
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveAttempt, setSaveAttempt] = useState(0);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [auth, setAuth] = useState({ configured: false, authorized: false });
  const [authWorking, setAuthWorking] = useState(false);
  const authBusy = useRef(false);
  const authRef = useRef(auth);
  const acceptAuth = (value: typeof auth) => { authRef.current = value; setAuth(value); };
  const revision = useRef(0);
  const saved = useRef('');
  const latest = useRef(data);
  const inFlight = useRef(false);
  const blocked = useRef(false);
  const [readOnly, setReadOnlyState] = useState(() => {
    const view = readShowLink(window.location.hash)?.view;
    return view === 'display' || view === 'dsm' || view === 'dsm-preview' || view === 'chroma';
  });
  const readOnlyRef = useRef(readOnly);
  const versions = useRef<Record<string, unknown>>({});
  // Track intent separately: replacing a running timer with the same value is a command too.
  const commands = useRef(new Map<string, number>());
  const commandSequence = useRef(0);
  const initialized = useRef(false);
  const wake = useRef(() => {});
  const setReadOnly = (value: boolean) => {
    if (readOnlyRef.current && !value && !initialized.current) setData(migrationData());
    readOnlyRef.current = value;
    setReadOnlyState(value);
  };
  const accept = (remote: Awaited<ReturnType<typeof requestState>>, base: Data, local: Data) => {
    const next = remote.initialized ? { shows: remote.shows, settings: remote.settings, templates: remote.templates || [] } :
      { shows: [], settings: { pin: '' } };
    acceptAuth(remote.auth);
    if (!remote.auth.authorized) commands.current.clear();
    const merged = remote.auth.authorized ? mergeState(base, local, next, versions.current, remote.timerVersions || {}, Array.from(commands.current.keys())) : next;
    revision.current = remote.revision;
    initialized.current = remote.initialized;
    versions.current = remote.timerVersions || {};
    saved.current = serialize(next);
    latest.current = merged;
    setData(merged);
  };
  latest.current = data;

  useEffect(() => {
    let cancelled = false;
    try { localStorage.removeItem('bayer-mock-pin'); } catch {}
    setError('');
    const load = async () => {
      try {
        let remote = await requestState();
        if (cancelled) return;
        if (!remote.initialized && !readOnlyRef.current) {
          try {
            remote = await requestState({ ...migrationData(), revision: remote.revision });
          } catch (failure) {
            if (!(failure instanceof DatabaseError) || !failure.conflict) throw failure;
            remote = await requestState();
          }
        }
        if (cancelled) return;
        const next = remote.initialized ? { shows: remote.shows, settings: remote.settings, templates: remote.templates || [] } :
          { shows: [], settings: { pin: '' } };
        revision.current = remote.revision;
        initialized.current = remote.initialized;
        versions.current = remote.timerVersions || {};
        acceptAuth(remote.auth);
        saved.current = serialize(next);
        setData(next);
        setLoaded(true);
      } catch (failure) {
        if (!cancelled) setError((failure as Error).message);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [loadAttempt]);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    let timer: number;
    let pollDue = Date.now() + 250;
    let saveDue: number | null = null;
    const needsSave = () => !readOnlyRef.current && !authBusy.current && authRef.current.authorized &&
      (!initialized.current || commands.current.size > 0 || serialize(latest.current) !== saved.current);
    const schedule = () => {
      window.clearTimeout(timer);
      if (cancelled || blocked.current || authBusy.current) return;
      if (needsSave()) {
        // Keep the first edit's deadline, even when a refresh or more edits arrive.
        saveDue ??= Date.now() + 200;
      } else {
        saveDue = null;
      }
      if (inFlight.current) return;
      timer = window.setTimeout(run, Math.max(0, (saveDue ?? pollDue) - Date.now()));
    };
    const run = async () => {
      if (cancelled || inFlight.current || blocked.current || authBusy.current) return;
      const writing = needsSave();
      if (writing && (saveDue === null || Date.now() < saveDue)) {
        schedule();
        return;
      }
      const snapshot = latest.current;
      const base = JSON.parse(saved.current) as Data;
      const sentCommands = new Map(commands.current);
      inFlight.current = true;
      if (writing) {
        saveDue = null;
        setSaving(true);
      }
      try {
        const remote = await requestState(writing ?
          { ...snapshot, revision: revision.current, timerCommands: timerCommands(base, snapshot, Array.from(sentCommands.keys())) } : undefined);
        if (!cancelled) {
          if (writing) {
            sentCommands.forEach((sequence, id) => {
              if (commands.current.get(id) === sequence) commands.current.delete(id);
            });
            versions.current = remote.timerVersions || {};
          }
          accept(remote, writing ? snapshot : base, latest.current);
          setError('');
        }
      } catch (failure) {
        if (!cancelled) {
          try {
            if (failure instanceof DatabaseError && failure.unauthorized) {
              const remote = await requestState();
              accept(remote, base, latest.current);
              setError('');
              return;
            }
            if (!writing || !(failure instanceof DatabaseError) || !failure.conflict) throw failure;
            const remote = await requestState();
            if (!cancelled) {
              accept(remote, base, latest.current);
              setError('');
            }
          } catch (mergeFailure) {
            if (!cancelled) {
              // Failed refreshes can retry; failed saves require explicit recovery.
              blocked.current = writing || !(mergeFailure instanceof DatabaseError) || mergeFailure.conflict;
              setConflict(!(mergeFailure instanceof DatabaseError) || mergeFailure.conflict);
              setError((mergeFailure as Error).message);
            }
          }
        }
      } finally {
        inFlight.current = false;
        if (!cancelled) {
          if (writing) {
            setSaving(false);
          }
          // Leave a quiet interval after completion, including on slow servers.
          pollDue = Date.now() + 250;
          setDirty(commands.current.size > 0 || serialize(latest.current) !== saved.current);
          schedule();
        }
      }
    };
    wake.current = schedule;
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      wake.current = () => {};
    };
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    setDirty(commands.current.size > 0 || serialize(data) !== saved.current);
    wake.current();
  }, [data, loaded, saveAttempt, readOnly]);

  useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, saving]);

  const retry = () => {
    if (!loaded) setLoadAttempt(attempt => attempt + 1);
    else {
      blocked.current = false;
      setSaveAttempt(attempt => attempt + 1);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(latest.current, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lem-time-unsaved.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const operatorAction = async (action: 'unlock' | 'lock' | 'configure', pin = '') => {
    if (authBusy.current) throw new Error('An authorization request is already in progress.');
    authBusy.current = true;
    setAuthWorking(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 40000);
    try {
      // Do not let an older poll overwrite a newly granted/revoked authorization.
      while (inFlight.current) await new Promise(resolve => window.setTimeout(resolve, 20));
      await establishOperatorCookie(stateApi, operatorHeaders);
      const response = await fetch(stateApi, {
        method: 'POST', headers: { ...operatorHeaders, 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ action, pin }), cache: 'no-store',
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to update operator authorization.');
      acceptAuth(result.auth);
      blocked.current = false;
      setError('');
      if (action === 'lock') {
        commands.current.clear();
        const remote = await requestState();
        accept(remote, latest.current, latest.current);
      }
    } finally {
      window.clearTimeout(timeout);
      authBusy.current = false;
      setAuthWorking(false);
      setSaveAttempt(attempt => attempt + 1);
    }
  };
  if (!loaded) {
    return <main className="mx-auto max-w-lg p-8">
      <h1>LEM-Time database</h1>
      {error ? <><p role="alert" className="my-4">{error}</p><button onClick={retry}>Retry connection</button></> :
        <p role="status">Loading saved shows…</p>}
    </main>;
  }
  return <DatabaseContext.Provider value={{
    shows: data.shows,
    setShows: update => { if (!readOnlyRef.current && !authBusy.current && authRef.current.authorized) setData(current => ({ ...current, shows: typeof update === 'function' ? update(current.shows) : update })); },
    pin: auth.configured ? 'configured' : '',
    authorized: auth.authorized && !authWorking,
    operatorAction,
    settings: data.settings,
    setSettings: update => { if (!readOnlyRef.current && !authBusy.current && authRef.current.authorized) setData(current => ({ ...current, settings: { ...(typeof update === 'function' ? update(current.settings) : update), pin: '' } })); },
    templates: data.templates || [],
    setTemplates: update => { if (!readOnlyRef.current && !authBusy.current && authRef.current.authorized) setData(current => ({ ...current, templates: typeof update === 'function' ? update(current.templates || []) : update })); },
    setReadOnly,
    timerVersion: id => serialize(versions.current[id]),
    setRemainingTime: (expected, version, seconds) => {
      if (readOnlyRef.current || authBusy.current || blocked.current || !authRef.current.authorized) return 'Timer controls are unavailable in this window.';
      if (!Number.isSafeInteger(seconds) || seconds <= 0) return 'Enter a positive whole remaining time.';
      const current = latest.current.shows.find(show => show.id === expected.id);
      const cue = current?.cues.find(cue => cue.id === current.active);
      if (!cue || (cue.type ?? 'countdown') !== 'countdown' || current?.active !== expected.active ||
          serialize(cue) !== serialize(expected.cues.find(cue => cue.id === expected.active)) ||
          serialize(versions.current[expected.id]) !== version) {
        return 'The active cue or timer changed. Close and reopen Set remaining time.';
      }
      commands.current.set(expected.id, ++commandSequence.current);
      const next = { ...latest.current, shows: latest.current.shows.map(show =>
        show.id === expected.id ? { ...show, left: seconds, status: 'Running' as const } : show) };
      latest.current = next;
      setData(next);
      return '';
    },
    status: error ? (readOnly ? 'Display refresh unavailable' : 'Changes not saved') : '',
  }}>
    {error ? <aside role="alert" className="sticky top-0 z-[60] border-b border-red-300 bg-red-50 p-3 text-red-900">
      <p>{error} {readOnly ? 'Display refresh is unavailable.' : 'Changes in this window are not saved.'}</p>
      <div className="mt-2 flex gap-4">
        {!conflict && <button onClick={retry}>{readOnly ? 'Retry refresh' : 'Retry save'}</button>}
        <button onClick={download}>Download unsaved data</button>
        {conflict && <button onClick={() => window.location.reload()}>Reload saved data</button>}
      </div>
    </aside> : null}
    {children}
  </DatabaseContext.Provider>;
}
