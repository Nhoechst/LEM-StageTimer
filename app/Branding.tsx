import { ReactNode, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Show, uid } from './data';
import { useDatabase } from './lib/database';
import { brandingSnapshot, DEFAULT_SETTINGS, isLogo, readLogo, sameTemplateName, LOGO_FIELDS, LOGO_NAME_FIELDS, SETTING_FIELDS } from './lib/branding.js';
import type { Branding, SiteSettings } from './lib/branding';
import { serialize } from './lib/sync.js';
import { isFont, readFont } from './lib/fonts.js';

const button = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold focus-visible:outline focus-visible:outline-2 disabled:opacity-45';
const input = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900';
export function FontUploads({ show, disabled, onChange }: {
  show: Show; disabled: boolean; onChange: (changes: Partial<Branding>) => void;
}) {
  return <div key={show.id}>
    <FontUpload key={show.id} show={show} disabled={disabled} onChange={onChange}/>
  </div>;
}
function FontUpload({ show, disabled, onChange }: {
  show: Show; disabled: boolean; onChange: (changes: Partial<Branding>) => void;
}) {
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), locked = useRef(disabled);
  locked.current = disabled;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const { timerFont, textFont } = show;
  const describe = (font: Show['timerFont']) => font ? `${font.name} · ${Math.ceil((font.data.split(',')[1].length * 3 / 4 - (font.data.endsWith('==') ? 2 : font.data.endsWith('=') ? 1 : 0)) / 1024)} KiB` : 'Built-in default';
  const mixed = serialize(timerFont ?? null) !== serialize(textFont ?? null);
  return <fieldset disabled={disabled || loading} className="mt-3 rounded-xl border border-slate-200 p-3">
    <label className="block text-sm font-bold">Font<input aria-label="Font" type="file" accept=".woff,.woff2,.ttf,.otf" className="mt-2 block w-full text-sm" onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file || locked.current) return;
      setLoading(true); setError('');
      try {
        const value = await readFont(file);
        if (alive.current && !locked.current) onChange({ timerFont: value, textFont: value });
      } catch (failure) { if (alive.current) setError((failure as Error).message); }
      finally { if (alive.current) setLoading(false); }
    }}/></label>
    <p className="my-2 break-all text-xs">{mixed ? `Mixed legacy fonts — Timer: ${describe(timerFont)}; Text: ${describe(textFont)}` : describe(timerFont)}</p>
    <button type="button" className={button} disabled={(!timerFont && !textFont) || loading || disabled} onClick={() => { if (!locked.current) { onChange({ timerFont: null, textFont: null }); setError(''); } }}>Remove font</button>
    {loading && <p role="status" className="text-xs">Validating font…</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </fieldset>;
}
export function LogoUpload({ label, logo, name, disabled, onChange, onLoadingChange }: {
  label: string; logo?: string; name?: string; disabled: boolean; onChange: (logo: string, name: string) => void;
  onLoadingChange?: (loading: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const locked = useRef(disabled);
  locked.current = disabled;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return <fieldset disabled={disabled || loading} className="mt-3 rounded-xl border border-slate-200 p-3">
    <label className="block text-sm font-bold">{label}<input aria-label={label} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="mt-2 block w-full text-sm" onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file || locked.current) return;
      setLoading(true); onLoadingChange?.(true); setError('');
      try {
        const url = await readLogo(file);
        if (file.name.length > 255) throw new Error('Use a filename of at most 255 characters.');
        if (alive.current && !locked.current) onChange(url, file.name);
      } catch (failure) { if (alive.current) setError((failure as Error).message); }
      finally { if (alive.current) setLoading(false); onLoadingChange?.(false); }
    }}/></label>
    <div className="my-2 flex items-center gap-3 rounded p-2" style={{ backgroundColor: label.startsWith('Dark') ? '#1e293b' : '#fff', color: label.startsWith('Dark') ? '#fff' : '#0f172a' }}>
      {logo && isLogo(logo) ? <img src={logo} alt={`${label} preview`} className="h-10 w-16 object-contain"/> : null}
      <span className="break-all text-xs">{name || (label.startsWith('Dark') ? 'Uses the default logo when empty' : 'No default logo; using placeholder')}</span>
    </div>
    <button type="button" disabled={!logo || loading || disabled} className={button} onClick={() => { onChange('', ''); setError(''); }}>Remove {label.toLowerCase()}</button>
    {loading && <p role="status" className="text-xs">Reading image…</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </fieldset>;
}
function Panel({ open, close, title, description, children }: { open: boolean; close: () => void; title: string; description: string; children: ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) close(); }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/45"/>
    <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-6 text-slate-900 shadow-2xl">
      <Dialog.Title className="text-xl font-bold">{title}</Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-slate-500">{description}</Dialog.Description>
      {children}
      <Dialog.Close className={`${button} mt-4`}>Close</Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

export function SavedTemplateSelect({ value, onChange, disabled = false }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const { templates } = useDatabase();
  return <label className="mb-3 block text-sm font-bold">Select template
    <select aria-label="Select template" value={value} disabled={disabled} onChange={event => onChange(event.target.value)} className={input}>
      <option value="">Built-in designs (choose below)</option>
      {templates.map(template => <option key={template.id} value={`saved:${template.id}`}>{template.name}</option>)}
    </select>
  </label>;
}

export function SavedBranding({ show, locked, apply }: { show: Show; locked: boolean; apply: (branding: Branding) => void }) {
  const { templates, setTemplates } = useDatabase();
  const [snapshot, setSnapshot] = useState<Branding | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (locked || !snapshot) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80 || /[\u0000-\u001f\u007f]/.test(trimmed)) { setError('Enter a template name of 1–80 characters without control characters.'); return; }
    if (templates.some(template => sameTemplateName(template.name, trimmed))) {
      setError('That name already exists. Choose a different name; existing templates are never overwritten.'); return;
    }
    if (!LOGO_FIELDS.every(key => isLogo(snapshot[key] || '')) || !LOGO_NAME_FIELDS.every(key => (snapshot[key] || '').length <= 255)) {
      setError('This logo cannot be saved as a template. Close this dialog and replace or remove the show logo, then try again. Use a supported image up to 512 KiB and a filename up to 255 characters.'); return;
    }
    if (!isFont(snapshot.timerFont ?? null) || !isFont(snapshot.textFont ?? null)) {
      setError('Replace or remove invalid fonts before saving this template.'); return;
    }
    if (templates.length >= 50) { setError('The site supports up to 50 saved templates.'); return; }
    setTemplates(current => [...current, { ...snapshot,
      id: globalThis.crypto?.randomUUID?.() || `template-${Date.now().toString(36)}-${uid()}`, name: trimmed }]);
    setSnapshot(null);
  };
  const selected = templates.find(template => serialize(brandingSnapshot(template)) === serialize(brandingSnapshot(show)));
  return <>
    <SavedTemplateSelect value={selected ? `saved:${selected.id}` : ''} disabled={locked} onChange={id => {
      const template = templates.find(item => `saved:${item.id}` === id);
      if (template && !locked) apply(brandingSnapshot(template));
    }}/>
    <button disabled={locked} className={`${button} mb-3`} onClick={() => { setSnapshot(brandingSnapshot(show)); setName(''); setError(''); }}>+ Add template</button>
    <Panel open={Boolean(snapshot)} close={() => setSnapshot(null)} title="Save branding template" description="Save a named copy of the current design, logos, and fonts. Cues, timers, blackout, and show details are not included.">
      <form onSubmit={save}>
        <label className="mt-4 block text-sm font-bold">Template name<input autoFocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} className={input}/></label>
        <p className="mt-2 text-xs text-slate-500">Names must be unique (case-insensitive). Saving never overwrites another template.</p>
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        {locked && <p role="alert">Unlock the show before saving.</p>}
        <button type="submit" disabled={locked} className={`${button} mt-4`}>Save template</button>
      </form>
    </Panel>
  </>;
}

export function SiteSettingsMenu({ locked }: { locked: boolean }) {
  const { settings, setSettings } = useDatabase();
  const [draft, setDraft] = useState<SiteSettings | null>(null);
  const [base, setBase] = useState<SiteSettings>({ pin: '' });
  const [error, setError] = useState('');
  const [modeLoading, setModeLoading] = useState(0);
  const busy = modeLoading > 0;
  const current = { ...DEFAULT_SETTINGS, ...settings };
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || locked || busy) return;
    const changes: Partial<SiteSettings> = {};
    for (const key of SETTING_FIELDS) {
      if (draft[key] !== base[key]) {
        if (current[key] !== base[key] && current[key] !== draft[key]) {
          setError('These settings changed in another window. Close and reopen Settings before saving.'); return;
        }
        changes[key] = draft[key];
      }
    }
    setSettings(value => ({ ...value, ...changes }));
    setDraft(null);
  };
  return <>
    <button className={button} disabled={locked} onClick={() => { setBase(current); setDraft(current); setError(''); }}>Settings</button>
    <Panel open={Boolean(draft)} close={() => setDraft(null)} title="Site settings" description="These site-wide settings are shared by everyone with access. Unlock this window with the operator PIN to make changes.">
      {draft && <form onSubmit={save}>
        <p className="mt-3 text-xs text-slate-500">Header logos follow the operator theme. Light mode uses the default logo; dark mode uses its optional logo or the default. Without a default, light mode shows the placeholder. Choose a file again to replace it.</p>
        {(['Light', 'Dark'] as const).map(mode => <LogoUpload key={mode} label={mode === 'Light' ? 'Default (light mode)' : 'Dark mode (optional)'} logo={draft[`headerLogo${mode}`]} name={draft[`headerLogoName${mode}`]} disabled={locked} onLoadingChange={value => setModeLoading(current => current + (value ? 1 : -1))} onChange={(logo, name) => setDraft(value => value && { ...value, ...(mode === 'Light' ? { headerLogo: '', headerLogoName: '' } : {}), [`headerLogo${mode}`]: logo, [`headerLogoName${mode}`]: name })}/>)}
        <label className="mt-4 block text-sm font-bold">Main header<input maxLength={200} value={draft.mainHeader} onChange={event => setDraft({ ...draft, mainHeader: event.target.value })} className={input}/></label>
        <label className="mt-4 block text-sm font-bold">Sub-header text<input maxLength={200} value={draft.subHeader} onChange={event => setDraft({ ...draft, subHeader: event.target.value })} className={input}/></label>
        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
        {serialize(current) !== serialize(base) && <p role="status" className="mt-3 text-xs">Site settings have changed since this dialog opened. Overlapping edits will be rejected.</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy || locked} className={button} onClick={() => setDraft({ ...draft, ...DEFAULT_SETTINGS })}>Reset to defaults</button>
          <button type="submit" disabled={locked || busy} className={button}>Save settings</button>
        </div>
      </form>}
    </Panel>
  </>;
}
