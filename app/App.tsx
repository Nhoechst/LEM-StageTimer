import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronDown, CircleDotDashed, Copy, Lock, Maximize, Monitor, MonitorOff, Moon, MoreHorizontal, Pause, Pencil, Pin, Play, Plus, RotateCcw, Sun, Timer, Trash2, Unlock, X } from 'lucide-react';
import { INITIAL_SHOWS as initial, TEMPLATE_LIST, Show, ShowMessage, Cue, CueType, fmt, uid } from './data';
import { cueType, modeLabel } from './lib/timer.js';
import { TimerValue } from './lib/timer-view';
import { BrandMark, DisplayPreview, DisplaySurface, DsmSurface, TemplatePicker } from './components';
import { DatabaseStatus, useDatabase } from './lib/database';
import { readShowLink, showLink } from './lib/show-links.js';
import { remainingSeconds } from './lib/remaining-time.js';
import { serialize } from './lib/sync.js';
import { FontUploads, LogoUpload, SavedBranding, SavedTemplateSelect, SiteSettingsMenu } from './Branding';
import { MessageComposer, OutputMessage, WorkspaceMessage } from './Messages';
import { brandingSnapshot, DEFAULT_SETTINGS, selectLogo } from './lib/branding.js';
function Button({children,onClick,disabled=false,kind='primary',className='',type='button',...props}:any){return <button {...props} type={type} disabled={disabled} onClick={onClick} className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2.5 text-sm font-bold transition focus:outline-none focus:ring-2 focus:ring-[#007a78] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 ${kind==='primary'?'bg-[#0069b4] text-white hover:bg-[#005897]':kind==='danger'?'bg-[#007a78] text-white hover:bg-[#006662]':'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'} ${className}`}>{children}</button>}
function Modal({open,onOpenChange,title,children}:any){return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className='fixed inset-0 z-40 bg-slate-950/45'/><Dialog.Content aria-describedby={undefined} className='fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl focus:outline-none'><Dialog.Title className='text-xl font-bold text-slate-900'>{title}</Dialog.Title>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>}
async function copyText(text:string){try{if(typeof navigator!=='undefined'&&navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return true}}catch{}try{if(typeof document==='undefined'||!document.body)return false;const textarea=document.createElement('textarea');textarea.value=text;textarea.setAttribute('readonly','');textarea.className='fixed left-[-9999px] top-0 opacity-0';document.body.appendChild(textarea);textarea.select();textarea.setSelectionRange(0,textarea.value.length);const copied=document.execCommand('copy');document.body.removeChild(textarea);return copied}catch{return false}}
function CopyLink({label,url}:any){const [status,setStatus]=useState<'idle'|'copied'|'unavailable'>('idle');const handleCopy=async()=>{const copied=await copyText(url);setStatus(copied?'copied':'unavailable');window.setTimeout(()=>setStatus('idle'),copied?1000:5000)};return <div className='rounded-xl border border-slate-200 p-3'><b className='text-sm'>{label}</b><div className='mt-2 flex items-center rounded-lg bg-slate-50 p-1 pl-2 text-xs text-slate-500'><input aria-label={`${label} address`} readOnly value={url} onFocus={e=>e.currentTarget.select()} className='min-w-0 flex-1 bg-transparent font-mono outline-none'/><button type='button' aria-label={`Copy ${label}`} onClick={handleCopy} className='ml-1 shrink-0 rounded p-2 text-[#0069b4] focus:outline-none focus:ring-2 focus:ring-[#007a78]'>{status==='copied'?<Check size={16}/>:<Copy size={16}/>}</button></div>{status==='copied'&&<p role='status' className='mt-2 text-xs font-semibold text-[#007a78]'>Copied.</p>}{status==='unavailable'&&<p role='status' className='mt-2 text-xs font-semibold text-[#007a78]'>Copy unavailable in this preview — select the URL manually.</p>}</div>}
function openOutput(view:'display'|'dsm-preview'|'chroma',id:string){
 // noopener can return null even when the browser successfully opens the window.
 window.open(showLink(window.location.href,view,id),'_blank','popup=yes,width=1280,height=800,resizable=yes,scrollbars=yes,noopener');
}
function ShowCard({show,onManage,onTogglePin,onDuplicate,onDelete,onRename,locked}:{
 show:Show; onManage:()=>void; onTogglePin:()=>void; onDuplicate:()=>void;
 onDelete:()=>void; onRename:(title:string)=>void; locked:boolean;
}) {
 const pinned=Boolean(show.pinnedAt);
 const [menuOpen,setMenuOpen]=useState(false);
 const [editingTitle,setEditingTitle]=useState(false);
 const [draftTitle,setDraftTitle]=useState(show.title);
 const menuRef=useRef<HTMLDivElement>(null);
 const menuButton=useRef<HTMLButtonElement>(null);
 const dismissing=useRef(false);
 useEffect(()=>{setDraftTitle(show.title)},[show.title]);
 useEffect(()=>{
  if(!menuOpen)return;
  const dismiss=(e:MouseEvent)=>{if(!menuRef.current?.contains(e.target as Node))setMenuOpen(false)};
  const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){setMenuOpen(false);menuButton.current?.focus()}};
  document.addEventListener('mousedown',dismiss);
  document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('mousedown',dismiss);document.removeEventListener('keydown',escape)};
 },[menuOpen]);
 const action=(fn:()=>void)=>{setMenuOpen(false);fn()};
 const saveTitle=()=>{
  const next=draftTitle.trim();
  if(!locked&&next&&next!==show.title)onRename(next);
  else setDraftTitle(show.title);
  setEditingTitle(false);
 };
 return <article className={`relative isolate w-full rounded-2xl border bg-white p-5 shadow-sm ${menuOpen?'z-30':''} ${pinned?'border-[#b8dfda]':'border-slate-200'}`}>
  <a href={showLink(window.location.href,'control',show.id)} aria-label={`Open ${show.title}`}
   className='absolute inset-0 z-0 rounded-2xl focus:outline-none focus:ring-2 focus:ring-[#007a78] focus:ring-offset-2'
   onPointerDown={e=>{
    // Blur and outside-menu dismissal must not turn the same click into navigation.
    dismissing.current=editingTitle||menuOpen;
    if(editingTitle)e.preventDefault();
   }}
   onPointerCancel={()=>{dismissing.current=false}}
   onAuxClick={e=>{
    if(dismissing.current||editingTitle){e.preventDefault();dismissing.current=false;if(editingTitle)saveTitle()}
   }}
   onClick={e=>{
    if(dismissing.current||editingTitle){e.preventDefault();dismissing.current=false;if(editingTitle)saveTitle();return}
    if(e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){e.preventDefault();onManage()}
   }}/>
  <div className='pointer-events-none relative z-10 flex items-start gap-3 max-sm:flex-wrap sm:gap-4'>
   <div className='w-[130px] shrink-0 max-sm:w-full sm:w-[155px]'>
    <DisplayPreview thumbnail show={show} activeName={show.cues.find(c=>c.id===show.active)?.name}/>
   </div>
   <div aria-label={`Details for ${show.title}`} className='min-w-0 flex-1 self-stretch'>
    <div className='flex items-start gap-1.5'>
     {editingTitle?<input autoFocus aria-label='Show display title' value={draftTitle} disabled={locked}
      onChange={e=>setDraftTitle(e.target.value)} onBlur={saveTitle}
      onKeyDown={e=>{
       if(e.key==='Enter'){e.preventDefault();saveTitle()}
       if(e.key==='Escape'){e.preventDefault();setDraftTitle(show.title);setEditingTitle(false)}
      }}
      className='pointer-events-auto block min-w-0 w-full rounded border border-[#0069b4] px-2 py-1 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-[#007a78]'/>:
      <><h3 className='min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] font-bold leading-5'>{show.title}</h3>
       <button disabled={locked} aria-label={`Edit title for ${show.title}`} onClick={()=>setEditingTitle(true)}
        className='pointer-events-auto shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-[#0069b4] disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-[#007a78]'><Pencil size={13}/></button></>}
    </div>
    <p className='mt-0.5 break-all font-mono text-xs text-slate-500'>{show.id}</p>
    <div className='mt-3 flex flex-wrap items-center gap-2'>
     <span className='rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-800'>{show.status}</span>
     {show.blackout&&<span role='status' className='rounded-full bg-[#063f70] px-2 py-1 text-xs font-bold text-white'>BLACKOUT ACTIVE</span>}
     {pinned&&<span className='inline-flex items-center gap-1 rounded-full bg-[#e8f3fb] px-2 py-1 text-xs font-bold text-[#007a78]'><Pin size={12} fill='currentColor'/>Pinned</span>}
    </div>
    <p className='mt-3 text-xs text-slate-500'>{show.cues.length} cue{show.cues.length===1?'':'s'} · {TEMPLATE_LIST.find(t=>t.id===show.templateId)?.name}</p>
   </div>
   <div className='pointer-events-auto relative shrink-0 self-start' ref={menuRef}>
    <button ref={menuButton} aria-label={`Show actions for ${show.title}`} aria-haspopup='menu' aria-expanded={menuOpen}
     onClick={()=>setMenuOpen(v=>!v)} className='rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-[#007a78]'><MoreHorizontal size={18}/></button>
    {menuOpen&&<div role='menu' aria-label={`Actions for ${show.title}`} className='absolute right-0 top-9 z-20 w-48 rounded-xl border border-slate-200 bg-white p-1 shadow-lg'>
     <button role='menuitem' disabled={locked} onClick={()=>action(onTogglePin)} className='flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-bold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45'><Pin size={16} fill={pinned?'currentColor':'none'}/>{pinned?'Unpin from top':'Pin to top'}</button>
     <button role='menuitem' disabled={locked} onClick={()=>action(onDuplicate)} className='flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-bold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45'><Copy size={16}/>Duplicate</button>
     <button role='menuitem' disabled={locked} onClick={()=>action(onDelete)} className='flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-bold text-[#007a78] hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45'><Trash2 size={16}/>Delete</button>
    </div>}
   </div>
  </div>
 </article>;
}
function SetRemainingTime({show, locked}: {show: Show; locked: boolean}) {
 const {timerVersion, setRemainingTime} = useDatabase();
 const [draft, setDraft] = useState<{show: Show; version: string} | null>(null);
 const [minutes, setMinutes] = useState('0');
 const [seconds, setSeconds] = useState('0');
 const [error, setError] = useState('');
 const active = show.cues.find(cue => cue.id === show.active);
 const countdown = cueType(show) === 'countdown';
 const total = remainingSeconds(minutes, seconds);
 const changed = draft && (draft.show.id !== show.id || draft.show.active !== show.active ||
   serialize(draft.show.cues.find(cue => cue.id === draft.show.active)) !== serialize(active) ||
   draft.version !== timerVersion(show.id));
 const unavailable = locked ? 'Unlock the show before setting remaining time.' :
   changed ? 'The active cue or timer changed. Close and reopen Set remaining time.' : '';
 const open = () => {
   if (locked || !active || !countdown) return;
   const left = Math.max(0, Math.ceil(show.left));
   setMinutes(String(Math.floor(left / 60)));
   setSeconds(String(left % 60));
   setError('');
   setDraft({show, version: timerVersion(show.id)});
 };
 const save = (event: React.FormEvent) => {
   event.preventDefault();
   if (!draft || unavailable || total === null) return;
   const failure = setRemainingTime(draft.show, draft.version, total);
   if (failure) setError(failure);
   else setDraft(null);
 };
 return <>
   {countdown && <Button disabled={locked || !active} onClick={open} kind='secondary'>Set remaining time</Button>}
   <Modal open={Boolean(draft)} onOpenChange={(open: boolean) => { if (!open) setDraft(null); }} title='Set remaining time'>
     <form onSubmit={save} noValidate>
       <p className='mt-2 text-sm text-slate-600'>Replace the active countdown and start immediately. The cue’s original duration is unchanged.</p>
       <div className='mt-4 grid grid-cols-2 gap-3'>
         <label className='text-sm font-bold'>Minutes<input autoFocus aria-label='Remaining minutes' type='text' inputMode='numeric' value={minutes} onChange={event => setMinutes(event.target.value)} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'/></label>
         <label className='text-sm font-bold'>Seconds<input aria-label='Remaining seconds' type='text' inputMode='numeric' value={seconds} onChange={event => setSeconds(event.target.value)} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'/></label>
       </div>
       {(unavailable || error || total === null) && <p role='alert' className='mt-3 text-sm text-red-700'>{unavailable || error || 'Use whole nonnegative minutes and seconds from 0 to 59, with a positive safe total.'}</p>}
       <div className='mt-5 flex justify-end gap-2'><Button kind='secondary' onClick={() => setDraft(null)}>Cancel</Button><Button type='submit' disabled={Boolean(unavailable) || total === null}>Save &amp; start</Button></div>
     </form>
   </Modal>
 </>;
}
function ThemeToggle() {
 const [dark,setDark]=useState(()=>{
  try {
   const saved=localStorage.getItem('lem-time-theme');
   if(saved==='dark'||saved==='light')return saved==='dark';
  } catch {}
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches??false;
 });
 useEffect(()=>{
  document.documentElement.dataset.theme=dark?'dark':'light';
  try {localStorage.setItem('lem-time-theme',dark?'dark':'light')} catch {}
 },[dark]);
 return <button type='button' aria-label='Dark mode' aria-pressed={dark} title={dark?'Switch to light mode':'Switch to dark mode'} onClick={()=>setDark(value=>!value)} className='inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-3 text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#007a78]'>
  {dark?<Sun size={18} aria-hidden='true'/>:<Moon size={18} aria-hidden='true'/>}
 </button>;
}
function PresentationControls({children}: {children: ReactNode}) {
 const corner = useRef<HTMLDivElement>(null);
 const [hovered, setHovered] = useState(false);
 const [touchOpen, setTouchOpen] = useState(false);
 useEffect(() => {
  const dismiss = (event: PointerEvent) => {
   if (corner.current?.contains(event.target as Node)) return;
   setHovered(false);
   setTouchOpen(false);
   if (corner.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  };
  document.addEventListener('pointerdown', dismiss);
  return () => document.removeEventListener('pointerdown', dismiss);
 }, []);
 return <div ref={corner} className='presentation-corner' data-open={hovered || touchOpen}
  onPointerEnter={event => {if (event.pointerType !== 'touch') setHovered(true)}}
  onPointerLeave={event => {if (event.pointerType !== 'touch') {setHovered(false);setTouchOpen(false)}}}>
  <div className='presentation-buttons'>{children}</div>
  {/* The transparent target catches the first touch without activating a hidden action. */}
  <button type='button' tabIndex={-1} aria-label='Show presentation controls' className='presentation-reveal'
   onPointerDown={event => event.preventDefault()} onClick={() => setTouchOpen(true)}/>
 </div>;
}
export default function App(){
 const [cueMode,setCueMode]=useState<CueType>('countdown');
 const [clockFormat,setClockFormat]=useState<'12h'|'24h'>('24h');
 const [cueError,setCueError]=useState('');
 const {shows,setShows,pin,authorized,operatorAction,setReadOnly,settings,templates}=useDatabase();
 const locked=Boolean(pin)&&!authorized;
 const site = { ...DEFAULT_SETTINGS, ...settings };
 const [route,setRoute]=useState(()=>readShowLink(window.location.hash));
 const applyingRoute=useRef(false);
 useEffect(()=>{
  applyingRoute.current=true;
  const navigate=()=>{applyingRoute.current=true;setRoute(readShowLink(window.location.hash))};
  window.addEventListener('hashchange',navigate);
  return()=>window.removeEventListener('hashchange',navigate);
 },[]);
 const [selected,setSelected]=useState(route?.id||initial[0].id),[view,setView]=useState<'dashboard'|'workspace'|'display'|'chromaPresentation'|'dsmPresentation'>(()=>route?.view==='dsm'?'dsmPresentation':route&&route.view!=='control'?'display':route?'workspace':'dashboard'),[green,setGreen]=useState(route?.view==='chroma'),[greenFullscreen,setGreenFullscreen]=useState(false),[dsm,setDsm]=useState(route?.view==='dsm-preview'),[dsmFullscreen,setDsmFullscreen]=useState(false),[dsmDigitsBlack,setDsmDigitsBlack]=useState(false),[invertedGreen,setInvertedGreen]=useState(false),[lockOpen,setLockOpen]=useState(false),[unlockOpen,setUnlockOpen]=useState(false),[pinDraft,setPinDraft]=useState(''),[confirm,setConfirm]=useState(''),[entered,setEntered]=useState(''),[error,setError]=useState(''),[pending,setPending]=useState<null|(()=>void)>(null),[cueOpen,setCueOpen]=useState(false),[cueName,setCueName]=useState(''),[cueM,setCueM]=useState('5'),[cueS,setCueS]=useState('0'),[editing,setEditing]=useState<string|null>(null),[titleEdit,setTitleEdit]=useState(false),[title,setTitle]=useState(''),[deleteOpen,setDeleteOpen]=useState(false),[showOpen,setShowOpen]=useState(false),[newShow,setNewShow]=useState(''),[newTemplate,setNewTemplate]=useState('bayer-light'),[blackoutOpen,setBlackoutOpen]=useState(false);
 useLayoutEffect(()=>{setReadOnly(view==='display'||view==='chromaPresentation'||view==='dsmPresentation')},[view]);
 useEffect(()=>{
  if(!route){setView('dashboard');return}
  setSelected(route.id);
  setGreen(route.view==='chroma');
  setDsm(route.view==='dsm-preview');
  setView(route.view==='dsm'?'dsmPresentation':route.view==='control'?'workspace':'display');
 },[route]);
 useEffect(()=>{
  if(applyingRoute.current){applyingRoute.current=false;return}
  const url=new URL(window.location.href);
  url.hash=view==='dashboard'?'':new URL(showLink(url.href,view==='dsmPresentation'?'dsm':view==='chromaPresentation'||(view==='display'&&green)?'chroma':view==='workspace'?'control':dsm?'dsm-preview':'display',selected)).hash;
  window.history.replaceState(null,'',url.href);
 },[selected,view,green,dsm]);
 const show=shows.find(s=>s.id===selected)||(view==='dashboard'?shows[0]:undefined); const active=show?.cues.find(c=>c.id===show.active); const patch=(f:(s:Show)=>Show)=>setShows(a=>a.map(s=>s.id===(show?.id||selected)?f(s):s)); const pinnedShows=shows.filter(s=>s.pinnedAt).sort((a,b)=>(a.pinnedAt||0)-(b.pinnedAt||0)); const unpinnedShows=shows.filter(s=>!s.pinnedAt); const togglePinned=(id:string)=>setShows(a=>a.map(s=>s.id===id?{...s,pinnedAt:s.pinnedAt?undefined:Date.now()}:s));
 const cleanDsm=view==='dsmPresentation'&&Boolean(show);
 useLayoutEffect(()=>{
  if(!cleanDsm)return;
  const html=document.documentElement;
  const previous=html.getAttribute('data-dsm-output');
  html.setAttribute('data-dsm-output','');
  return()=>{if(previous===null)html.removeAttribute('data-dsm-output');else html.setAttribute('data-dsm-output',previous)};
 },[cleanDsm]);
 const closeChromaPresentation=(leaveNativeFullscreen=true)=>{if(leaveNativeFullscreen&&document.fullscreenElement){try{document.exitFullscreen?.()}catch{}}setGreenFullscreen(false);setGreen(false);setInvertedGreen(false);setView('workspace')}; const openChromaFullscreen=async()=>{setGreenFullscreen(true);setView('chromaPresentation');try{await document.documentElement.requestFullscreen?.()}catch{}};
 useEffect(()=>{if(!greenFullscreen)return;const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')closeChromaPresentation()};const onChange=()=>{if(!document.fullscreenElement)closeChromaPresentation(false)};window.addEventListener('keydown',onKey);document.addEventListener('fullscreenchange',onChange);return()=>{window.removeEventListener('keydown',onKey);document.removeEventListener('fullscreenchange',onChange)}},[greenFullscreen]);
 const closeDsmPresentation=(leaveNativeFullscreen=true)=>{if(leaveNativeFullscreen&&document.fullscreenElement){try{document.exitFullscreen?.()}catch{}}setDsmFullscreen(false);setDsmDigitsBlack(false);setDsm(true);setView('display')}; const openDsmFullscreen=async()=>{setDsmDigitsBlack(false);setDsmFullscreen(true);setView('dsmPresentation');try{await document.documentElement.requestFullscreen?.()}catch{}};
 useEffect(()=>{if(view!=='dsmPresentation')return;const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')closeDsmPresentation()};const onChange=()=>{if(dsmFullscreen&&!document.fullscreenElement)closeDsmPresentation(false)};window.addEventListener('keydown',onKey);document.addEventListener('fullscreenchange',onChange);return()=>{window.removeEventListener('keydown',onKey);document.removeEventListener('fullscreenchange',onChange)}},[view,dsmFullscreen]);
 const protect=(task:()=>void)=>{if(locked&&pin){setPending(()=>task);setEntered('');setError('');setUnlockOpen(true)}else task()}; const verify=async()=>{try{await operatorAction('unlock',entered);setEntered('');setUnlockOpen(false);const job=pending;setPending(null);job?.()}catch(error){setError((error as Error).message)}};
 const savePin=async()=>{if(!/^\d{4,6}$/.test(pinDraft)){setError('Use a numeric PIN with 4–6 digits.');return}if(pinDraft!==confirm){setError('PIN confirmation does not match.');return}try{if(pin)await operatorAction('unlock',entered);await operatorAction('configure',pinDraft);setEntered('');setPinDraft('');setConfirm('');setError('');setLockOpen(false)}catch(error){setError((error as Error).message)}}; const disablePin=async()=>{try{await operatorAction('unlock',entered);await operatorAction('configure','');setEntered('');setError('');setLockOpen(false)}catch(error){setError((error as Error).message)}};
 const relock=async()=>{try{await operatorAction('lock')}catch(error){setError((error as Error).message);setUnlockOpen(true)}};
 const run=()=>protect(()=>patch(s=>!s.active||cueType(s)==='clock'?s:{...s,status:s.status==='Running'?'Paused':'Running',left:cueType(s)==='countdown'?(s.left||s.cues.find(c=>c.id===s.active)?.duration||0):s.left})); const reset=()=>protect(()=>patch(s=>({...s,left:s.cues.find(c=>c.id===s.active)?.duration||0,status:'Ready'}))); const adjust=(n:number)=>protect(()=>patch(s=>cueType(s)!=='countdown'?s:{...s,left:Math.max(0,s.left+n)}));
 const saveCue=()=>protect(()=>{
   const d=cueMode==='clock'?0:Number(cueM)*60+Number(cueS);
   if(!cueName.trim()){setCueError('Enter a cue name.');return}
   if(cueMode!=='clock'&&(!/^\d+$/.test(cueM)||!/^\d+$/.test(cueS)||Number(cueS)>59||!Number.isSafeInteger(d)||d<0)){setCueError('Use whole nonnegative minutes and seconds from 0 to 59.');return}
   const c:Cue={id:editing||uid(),name:cueName.trim(),duration:d,type:cueMode,...(cueMode==='clock'?{clockFormat}:{})};
   patch(s=>{
     const previous=s.cues.find(x=>x.id===editing);
     const resetActive=s.active===editing&&(previous?.duration!==d||(previous?.type??'countdown')!==cueMode);
     return {...s,cues:editing?s.cues.map(x=>x.id===editing?c:x):[...s.cues,c],...(resetActive?{left:d,status:'Ready' as const}:{})};
   });
   setCueOpen(false);setCueName('');setEditing(null);setCueError('');
 });
 const messageDrafts=useRef(new Map<string,ShowMessage>());
 const uploadLocked=useRef(locked);uploadLocked.current=locked;
 const duplicateShow=(source:Show)=>{const id=`SHOW-${uid().toUpperCase()}`;const copy:Show={...source,id,title:`${source.title} (Copy)`,cues:source.cues.map(c=>({...c,id:uid()})),active:undefined,left:0,status:'Ready',pinnedAt:undefined,blackout:false};setShows(a=>[...a,copy])}; const requestDashboardDelete=(id:string)=>{setSelected(id);setDeleteOpen(true)}; const control=showLink(window.location.href,'control',show?.id||''),display=showLink(window.location.href,'display',show?.id||'');
 if(view!=='dashboard'&&!show)return <main className='min-h-screen bg-[#f7fafc] p-8 text-slate-900'><h1>Show not found</h1><p>This show may have been deleted or the link is incorrect.</p><button onClick={()=>{window.location.hash='';setRoute(null);setView('dashboard')}} className='mt-4 font-bold text-[#0069b4]'>All Shows</button></main>;
 if((view==='dsmPresentation'||view==='chromaPresentation')&&show?.blackout){const exit=()=>view==='dsmPresentation'?closeDsmPresentation():closeChromaPresentation();return <main className='relative min-h-screen bg-black' aria-label='Blackout active'><PresentationControls key='blackout'><button aria-label='Exit blackout presentation' title='Exit presentation' onClick={exit} className='rounded-full bg-slate-950/70 p-3 text-white focus:outline-none focus:ring-2 focus:ring-white'><X size={20}/></button></PresentationControls></main>};if(view==='dsmPresentation'&&show)return <main className='relative min-h-screen overflow-hidden bg-transparent'><DsmSurface show={show} fullscreen digitBlack={dsmDigitsBlack}/><PresentationControls key='dsm'><button aria-label={dsmDigitsBlack?'Switch timer digits to white':'Switch timer digits to black'} title={dsmDigitsBlack?'Switch timer digits to white':'Switch timer digits to black'} onClick={()=>setDsmDigitsBlack(v=>!v)} className='rounded-full bg-slate-950/70 p-3 text-white focus:outline-none focus:ring-2 focus:ring-white'><CircleDotDashed size={20}/></button><button aria-label='Exit DSM presentation' title='Exit DSM presentation' onClick={()=>closeDsmPresentation()} className='rounded-full bg-slate-950/70 p-3 text-white focus:outline-none focus:ring-2 focus:ring-white'><X size={20}/></button></PresentationControls></main>;
 if(view==='chromaPresentation'&&show)return <main className='relative grid min-h-screen place-items-center bg-[#00c853]'><OutputMessage show={show} destination='chroma'/><PresentationControls key='chroma'><button aria-label={invertedGreen?'Switch timer digits to white':'Switch timer digits to black'} title={invertedGreen?'Switch timer digits to white':'Switch timer digits to black'} onClick={()=>setInvertedGreen(v=>!v)} className='rounded-full bg-slate-950/70 p-3 text-white focus:outline-none focus:ring-2 focus:ring-white'><CircleDotDashed size={20}/></button><button aria-label='Exit Chroma presentation' title='Exit Chroma presentation' onClick={()=>closeChromaPresentation()} className='rounded-full bg-slate-950/70 p-3 text-white focus:outline-none focus:ring-2 focus:ring-white'><X size={20}/></button></PresentationControls><span className={`font-mono text-7xl font-bold sm:text-9xl ${invertedGreen?'text-black':'text-white'}`}><TimerValue show={show}/></span></main>;
 if(view==='display'&&show)return green?<main className='min-h-screen bg-slate-100 p-5'><div className='mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 shadow-sm'><div><b>Chroma presentation preview</b><p className='text-xs text-slate-500'>Clean chroma-key timer output</p></div><div className='flex gap-2'><Button kind='secondary' onClick={openChromaFullscreen} aria-label='Expand Chroma display'><Maximize size={16}/>Expand</Button><Button kind='secondary' onClick={()=>{setGreen(false);setInvertedGreen(false);setView('workspace')}}>Back to Show</Button></div></div>{show.blackout?<section aria-label='Blackout active' className='min-h-[70vh] rounded-2xl bg-black shadow-xl'/>:<section className='relative grid min-h-[70vh] place-items-center rounded-2xl bg-[#00c853] p-8 shadow-xl'><OutputMessage show={show} destination='chroma'/><span className={`font-mono text-7xl font-bold sm:text-9xl ${invertedGreen?'text-black':'text-white'}`}><TimerValue show={show}/></span></section>}</main>:<main className='min-h-screen bg-slate-100 p-5'><div className='mb-5 flex justify-between rounded-xl bg-white p-4 shadow-sm'><div>{!dsm&&<><b>{show.title}</b><p className='text-xs text-slate-500'>Read-only display preview</p></>}{dsm&&<><b>DSM viewer</b><p className='text-xs text-slate-500'>Transparent bottom-right timer output</p></>}</div><div className='flex gap-2'>{dsm&&<Button kind='secondary' onClick={openDsmFullscreen} aria-label='Expand DSM display'><Maximize size={16}/>Expand</Button>}<Button kind='secondary' onClick={()=>{setDsmFullscreen(false);setDsm(false);setView('workspace')}}>Back to Show</Button></div></div>{dsm?<><div className='mb-3 rounded-xl bg-white p-3'><CopyLink label='DSM output URL' url={showLink(window.location.href,'dsm',show.id)}/><p className='mt-2 text-xs text-slate-500'>Alpha is enabled by default. Use the clean output URL in an alpha-capable capture such as OBS Browser Source. Ordinary browser windows are not see-through.</p></div><DsmSurface show={show}/></>:<DisplaySurface show={show} activeName={active?.name}/>}</main>;
 return <main className='min-h-screen bg-[#f7fafc] text-slate-900'><header className='border-b border-slate-200 bg-white'><div className='mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4'><div className='flex min-w-0 items-center gap-3'><span className='theme-logo-light'><BrandMark compact uploaded={selectLogo('light',site.headerLogoLight,site.headerLogoDark)}/></span><span className='theme-logo-dark'><BrandMark compact uploaded={selectLogo('dark',site.headerLogoLight,site.headerLogoDark)}/></span><div className='min-w-0 break-words'><h1 className='font-bold'>{site.mainHeader}</h1><p className='text-xs text-slate-500'>{site.subHeader}</p></div></div> <nav aria-label='Main navigation' className='flex flex-wrap items-center gap-4'><DatabaseStatus/><SiteSettingsMenu locked={locked}/><ThemeToggle/></nav></div></header><div className='mx-auto max-w-7xl px-5 py-6'>
 {view==='dashboard'&&locked&&<p role='status' className='mb-5 text-sm text-slate-600'>Editing, deleting, and Settings are locked. Open a show and select Unlock Show, or authorize through Add Show. The PIN protects this installation, not individual shows.</p>}
 {view==='dashboard'?<><div className='mb-5 flex items-end justify-between'><div><p className='text-sm font-bold text-[#007a78]'>EVENT OPERATIONS</p><h2 className='text-3xl font-bold'>Shows at a glance</h2></div><Button onClick={()=>setShowOpen(true)}><Plus size={17}/>Add Show</Button></div>{pinnedShows.length>0&&<><p className='mb-3 text-sm font-bold text-[#007a78]'>Pinned shows</p><div className='mb-6 space-y-4'>{pinnedShows.map(s=><ShowCard key={s.id} show={s} locked={locked} onManage={()=>{setSelected(s.id);setView('workspace')}} onTogglePin={()=>togglePinned(s.id)} onDuplicate={()=>duplicateShow(s)} onDelete={()=>requestDashboardDelete(s.id)} onRename={title=>setShows(a=>a.map(x=>x.id===s.id?{...x,title}:x))}/>)}</div></>}<div className='space-y-4'>{unpinnedShows.map(s=><ShowCard key={s.id} show={s} locked={locked} onManage={()=>{setSelected(s.id);setView('workspace')}} onTogglePin={()=>togglePinned(s.id)} onDuplicate={()=>duplicateShow(s)} onDelete={()=>requestDashboardDelete(s.id)} onRename={title=>setShows(a=>a.map(x=>x.id===s.id?{...x,title}:x))}/>)}</div></>:show&&<section><button onClick={()=>setView('dashboard')} className='mb-5 text-sm font-bold text-[#0069b4]'>← All Shows</button><div className='grid gap-6 lg:grid-cols-[1fr_340px]'><div className='min-w-0 space-y-5'><div aria-label='Timer panel' className='rounded-2xl bg-[#063f70] p-6 text-white shadow-lg sm:p-8'>
   <div className='grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3'>
     <div className='min-w-0'>
       <p className='text-xs font-bold tracking-widest text-[#9ed7f0]'>SHOW WORKSPACE {locked&&'· LOCKED'}</p>
       {titleEdit?<div className='mt-2 flex flex-wrap gap-2'><input autoFocus value={title} onChange={e=>setTitle(e.target.value)} className='min-w-0 w-full rounded-lg px-3 py-2 text-slate-900'/><Button onClick={()=>protect(()=>{patch(s=>({...s,title:title||s.id}));setTitleEdit(false)})}>Save</Button></div>:<div className='flex flex-wrap items-center gap-2'><h2 className='min-w-0 break-words text-2xl font-bold'>{show.title}</h2><button aria-label='Edit show title' disabled={locked} onClick={()=>{setTitle(show.title);setTitleEdit(true)}} className='rounded border border-white/30 p-1.5 disabled:opacity-45'><Pencil size={14}/></button>{locked&&<span className='rounded-full bg-white/15 px-2.5 py-1 text-xs font-bold'>Locked</span>}</div>}
     </div>
     <div role='group' aria-label='Show controls' className='flex shrink-0 gap-2'>
       <button type='button' title={locked?'Unlock Show':pin?'Lock Show':'Set Show PIN'} aria-label={locked?'Unlock Show':pin?'Lock Show':'Set Show PIN'} aria-pressed={locked} onClick={()=>pin?(locked?(setEntered(''),setError(''),setUnlockOpen(true)):void relock()):(setError(''),setLockOpen(true))} className={`rounded-lg border p-3 transition focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-[#063f70] ${locked?'border-white bg-white text-[#063f70]':'border-white/40 bg-white/10 text-white hover:bg-white/20'}`}>{locked?<Lock aria-hidden='true' size={20}/>:<Unlock aria-hidden='true' size={20}/>}</button>
       <button type='button' title={show.blackout?'Clear blackout':'Blackout'} aria-label={show.blackout?'Clear blackout':'Blackout'} aria-pressed={Boolean(show.blackout)} disabled={locked} onClick={()=>protect(()=>show.blackout?patch(s=>({...s,blackout:false})):setBlackoutOpen(true))} className={`rounded-lg border p-3 transition focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-[#063f70] disabled:cursor-not-allowed disabled:opacity-45 ${show.blackout?'border-white bg-white text-[#063f70]':'border-white/40 bg-white/10 text-white hover:bg-white/20'}`}><MonitorOff aria-hidden='true' size={20}/></button>
     </div>
   </div>
   <p className='mt-2 break-words text-sm text-[#9ed7f0]'>{active?`Active cue: ${active.name}`:'Activate a cue to begin.'}</p>
   <div className='mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#9ed7f0]'>
     <span>{pin?(locked?'This window is locked.':'PIN configured; this window is authorized.'):'No PIN configured.'}</span>
     <button onClick={()=>{setEntered('');setError('');setLockOpen(true)}} className='rounded font-bold text-white underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-white'>{pin?'Change or remove PIN':'Configure PIN lock'}</button>
   </div>
   {show.blackout&&<p role='status' className='mt-2 rounded-lg border border-white/40 bg-white/15 px-3 py-2 text-xs font-bold text-white'>BLACKOUT ACTIVE — LIVE OUTPUT IS BLACK. Timers continue running.</p>}
   <WorkspaceMessage show={show}/>
   <div className='my-7'><p aria-label='Current timer value' className='text-center font-mono text-5xl font-bold sm:text-7xl'><TimerValue show={show}/></p><div className='mt-4 grid place-items-center'><span className='rounded-full bg-white/15 px-3 py-1 text-sm font-bold'>{cueType(show)==='clock'?'Local Time':show.status}</span>{active&&cueType(show)!=='clock'&&<span className='mt-2 text-xs'>{modeLabel(cueType(show))}</span>}</div></div>
   <div className='flex flex-wrap justify-center gap-2'>
   {cueType(show)!=='clock'&&<><Button disabled={!active||locked} onClick={run} kind={show.status==='Running'?'secondary':'primary'}>{show.status==='Running'?<Pause/>:<Play/>}{show.status==='Running'?'Pause':'Start'}</Button><Button disabled={!active||locked} onClick={reset} kind='secondary'><RotateCcw size={17}/>Reset</Button></>}
   {cueType(show)==='countdown'&&<><Button disabled={!active||locked} onClick={()=>adjust(-60)} kind='secondary'>−1 min</Button><Button disabled={!active||locked} onClick={()=>adjust(60)} kind='secondary'>+1 min</Button></>}
 <SetRemainingTime show={show} locked={locked}/>
 </div></div>
 <div className='rounded-2xl border border-slate-200 bg-white p-5'>
   <div className='flex justify-between gap-3'><div><h3 className='font-bold'>Show cues</h3><p className='text-sm text-slate-500'>Configure countdowns, count-up timers, and Local Time.</p></div><Button disabled={locked} onClick={()=>{setEditing(null);setCueName('');setCueMode('countdown');setClockFormat('24h');setCueM('5');setCueS('0');setCueError('');setCueOpen(true)}}><Plus size={16}/>Add Cue</Button></div>
   <div className='mt-5 space-y-3'>{show.cues.map(c=><div key={c.id} className={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${c.id===show.active?'border-[#0069b4] bg-[#e8f3fb]':'border-slate-200'}`}>
     <div className='min-w-[130px] flex-1'><b>{c.name}</b><p className='font-mono text-sm text-slate-500'>{modeLabel(c.type??'countdown')}{c.type!=='clock'&&` · ${c.type==='countup'?'Start at ':''}${fmt(c.duration)}`}</p></div>
     {c.id===show.active&&<span className='rounded-full bg-[#007a78] px-2 py-1 text-xs font-bold text-white'>ACTIVE</span>}
     <Button disabled={locked} kind='secondary' onClick={()=>protect(()=>patch(s=>({...s,active:c.id,left:c.duration,status:'Ready'})))}>Activate</Button>
     <button disabled={locked} onClick={()=>{setEditing(c.id);setCueName(c.name);setCueMode(c.type??'countdown');setClockFormat(c.clockFormat??'24h');setCueError('');setCueM(String(Math.floor(c.duration/60)));setCueS(String(c.duration%60));setCueOpen(true)}} className='text-sm font-bold text-[#0069b4] disabled:opacity-45'>Edit</button>
     <button aria-label={`Delete cue ${c.name}`} disabled={locked} onClick={()=>protect(()=>patch(s=>({...s,cues:s.cues.filter(x=>x.id!==c.id),active:s.active===c.id?undefined:s.active,status:s.active===c.id?'Ready':s.status,left:s.active===c.id?0:s.left})))} className='text-[#007a78] disabled:opacity-45'><Trash2 size={17}/></button>
   </div>)}</div>
 </div>
 <div aria-label='Show links' className='rounded-2xl border border-slate-200 bg-white p-5'><h3 className='font-bold'>Show links</h3><div className='mt-3 space-y-2'><CopyLink label='Control URL' url={control}/><CopyLink label='Display URL' url={display}/></div><Button className='mt-3 w-full' kind='secondary' onClick={()=>openOutput('display',show.id)}><Monitor size={16}/>Preview display</Button><div className='mt-2 grid grid-cols-1 gap-2 min-[320px]:grid-cols-2'><Button className='min-w-0 px-2.5 py-2 text-xs' kind='secondary' onClick={()=>openOutput('chroma',show.id)}>Open Chroma mode</Button><Button className='min-w-0 px-2.5 py-2 text-xs' kind='secondary' onClick={()=>openOutput('dsm-preview',show.id)}>Open DSM</Button></div><p className='mt-2 text-xs text-slate-500'>Outputs open in separate windows (your browser may use tabs). Allow popups for this site if no viewer appears.</p></div>
 </div><aside className='space-y-5'><MessageComposer key={show.id} show={show} drafts={messageDrafts.current} locked={locked} publish={message=>{if(!locked)patch(s=>({...s,message}))}}/><details className='group rounded-2xl border border-slate-200 bg-white p-5'>
   <summary className='flex cursor-pointer list-none items-center justify-between gap-2 rounded focus:outline-none focus:ring-2 focus:ring-[#007a78]'><h3 className='flex items-center gap-2 font-bold'><Timer size={18} className='text-[#0069b4]'/>Template</h3><ChevronDown aria-hidden='true' size={18} className='shrink-0 transition group-open:rotate-180'/></summary>
   <div>
   <p className='mt-1 text-sm text-slate-500'>Changes update the normal display preview immediately. Saved templates change branding only, never cues or timer progress.</p>
   <div className='mt-4'><SavedBranding show={show} locked={locked} apply={branding=>protect(()=>patch(s=>({...s,...branding})))}/><TemplatePicker value={show.templateId} disabled={locked} onChange={(id:string)=>protect(()=>patch(s=>({...s,templateId:id})))} compact/></div>
   <label className='mt-4 flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-3 text-sm font-bold'>Logo on display<input aria-label='Logo on display' type='checkbox' checked={show.logoOn} disabled={locked} onChange={e=>protect(()=>patch(s=>({...s,logoOn:e.target.checked})))} className='h-4 w-4 accent-[#0069b4]'/></label>
   {(['Light','Dark'] as const).map(mode=><LogoUpload key={`${show.id}-${mode}`} label={mode==='Light'?'Default (light mode)':'Dark mode (optional)'} logo={show[`uploadedLogo${mode}`]} name={show[`logoName${mode}`]} disabled={locked} onChange={(logo,name)=>{if(uploadLocked.current)return;const id=show.id;setShows(current=>current.map(item=>item.id===id?{...item,...(mode==='Light'?{uploadedLogo:'',logoName:''}:{}),[`uploadedLogo${mode}`]:logo,[`logoName${mode}`]:name}:item))}}/>)}
   <FontUploads key={show.id} show={show} disabled={locked} onChange={changes=>protect(()=>patch(s=>({...s,...changes})))}/>
   </div>
 </details></aside></div></section>}
 </div>
 <Modal open={blackoutOpen} onOpenChange={setBlackoutOpen} title='Enable blackout?'><p className='mt-2 text-sm text-slate-600'>This immediately removes every on-screen element from this Show’s normal, DSM, and Chroma outputs. Timers continue running in the background.</p><div className='mt-5 flex justify-end gap-2'><Button kind='secondary' onClick={()=>setBlackoutOpen(false)}>Cancel</Button><Button kind='danger' onClick={()=>{patch(s=>({...s,blackout:true}));setBlackoutOpen(false)}}>Enable Blackout</Button></div></Modal>
 <Modal open={lockOpen} onOpenChange={setLockOpen} title={pin?'Manage operator PIN':'Set Show PIN'}>
   <p className='mt-1 text-sm text-slate-500'>The PIN protects this installation. Each operator window authorizes separately. PINs are never shown after saving.</p>
   {pin&&<label className='mt-4 block text-sm font-bold'>Current PIN<input autoFocus type='password' inputMode='numeric' maxLength={6} value={entered} onChange={e=>{setEntered(e.target.value.replace(/\D/g,''));setError('')}} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'/></label>}
   <label className='mt-4 block text-sm font-bold'>New numeric PIN (4–6 digits)<input autoFocus={!pin} type='password' inputMode='numeric' maxLength={6} value={pinDraft} onChange={e=>{setPinDraft(e.target.value.replace(/\D/g,''));setError('')}} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'/></label>
   <label className='mt-3 block text-sm font-bold'>Confirm PIN<input type='password' inputMode='numeric' maxLength={6} value={confirm} onChange={e=>{setConfirm(e.target.value.replace(/\D/g,''));setError('')}} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'/></label>
   <Button className='mt-5 w-full' onClick={savePin}>{pin?'Change PIN':'Save PIN'}</Button>
   {pin&&<Button className='mt-3 w-full' kind='danger' onClick={disablePin}>Remove PIN / Disable Lock</Button>}
   {error&&<p role='alert' className='mt-3 text-sm font-semibold text-[#007a78]'>{error}</p>}
 </Modal>
 <Modal open={unlockOpen} onOpenChange={open=>{setUnlockOpen(open);if(!open)setPending(null)}} title='Unlock Show'><p className='mt-1 text-sm text-slate-500'>Enter the installation PIN to authorize controls for all shows and Settings in this window only. Other windows stay locked.</p><label className='mt-4 block text-sm font-bold'>Show PIN<input autoFocus type='password' inputMode='numeric' maxLength={6} value={entered} onChange={e=>{setEntered(e.target.value.replace(/\D/g,''));setError('')}} onKeyDown={e=>e.key==='Enter'&&verify()} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'/></label>{error&&<p role='alert' className='mt-3 text-sm font-semibold text-[#007a78]'>{error}</p>}<div className='mt-5 flex justify-end gap-2'><Button kind='secondary' onClick={()=>{setUnlockOpen(false);setPending(null)}}>Cancel</Button><Button onClick={verify}><Unlock size={16}/>Unlock Show</Button></div></Modal>
 <Modal open={cueOpen} onOpenChange={setCueOpen} title={editing?'Edit Cue':'Add Cue'}>
   <label className='mt-4 block text-sm font-bold'>Cue name<input value={cueName} onChange={e=>setCueName(e.target.value)} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'/></label>
   <label className='mt-3 block text-sm font-bold'>Cue type<select aria-label='Cue type' value={cueMode} onChange={e=>{const type=e.target.value as CueType;setCueMode(type);setCueError('');if(!editing){setCueM(type==='countdown'?'5':'0');setCueS('0')}}} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'>
     <option value='countdown'>Countdown</option><option value='countup'>Count-up Timer</option><option value='clock'>Local Time</option>
   </select></label>
   {cueMode==='clock'?<label className='mt-3 block text-sm font-bold'>Time format<select aria-label='Time format' value={clockFormat} onChange={event=>setClockFormat(event.target.value as '12h'|'24h')} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'><option value='24h'>24 hour</option><option value='12h'>12 hour (AM/PM)</option></select></label>:<p className='mt-2 text-sm text-slate-500'>{cueMode==='countup'?'Starting elapsed value. Reset restores this value; the timer has no end limit.':'Countdown duration. Reset restores this duration.'}</p>}
   {cueMode!=='clock'&&<div className='mt-3 grid grid-cols-2 gap-3'><label className='text-sm font-bold'>Minutes<input type='number' min='0' value={cueM} onChange={e=>setCueM(e.target.value)} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'/></label><label className='text-sm font-bold'>Seconds<input type='number' min='0' max='59' value={cueS} onChange={e=>setCueS(e.target.value)} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'/></label></div>}
   {cueError&&<p role='alert' className='mt-3 text-sm text-red-700'>{cueError}</p>}
   <Button className='mt-5 w-full' onClick={saveCue}>Save Cue</Button>
 </Modal>
 <Modal open={deleteOpen&&view==='dashboard'} onOpenChange={setDeleteOpen} title='Permanently delete Show?'><p className='mt-2 text-sm text-slate-700'>You are about to permanently remove <b>{show?.title||'this Show'}</b> <span className='font-mono text-xs text-slate-500'>({show?.id||selected})</span>.</p><p className='mt-3 text-sm text-slate-500'>Its cues, display configuration, messages, branding and uploaded logo state, blackout state, and all other mock-session data will be removed. This cannot be undone.</p><div className='mt-5 flex justify-end gap-2'><Button kind='secondary' onClick={()=>setDeleteOpen(false)}>Cancel</Button><Button kind='danger' disabled={locked} onClick={()=>{if(locked)return;const rest=shows.filter(s=>s.id!==selected);setShows(rest);setSelected(rest[0]?.id||'');setDeleteOpen(false);setView('dashboard')}}><Trash2 size={16}/>Delete Show</Button></div></Modal>
 <Modal open={showOpen} onOpenChange={setShowOpen} title='Add Show'>{locked&&<div className='mt-3 text-sm'><p role='status'>Adding shows requires the installation PIN. Authorize below, or close this dialog and open a show to select Unlock Show.</p><Button kind='secondary' className='mt-3' onClick={()=>{setShowOpen(false);setEntered('');setError('');setPending(()=>()=>setShowOpen(true));setUnlockOpen(true)}}>Authorize to add shows</Button></div>}<label className='mt-4 block text-sm font-bold'>Show name<input value={newShow} onChange={e=>setNewShow(e.target.value)} className='mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5'/></label><div className='mt-4'><p className='mb-2 text-sm font-bold'>Branding template</p><SavedTemplateSelect value={newTemplate.startsWith('saved:')?newTemplate:''} onChange={id=>setNewTemplate(id||'bayer-light')}/><TemplatePicker value={newTemplate} onChange={setNewTemplate}/></div><Button disabled={locked} className='mt-5 w-full' onClick={()=>{if(locked||!newShow.trim())return;const id=`SHOW-${uid().toUpperCase()}`;const saved=templates.find(t=>`saved:${t.id}`===newTemplate);if(newTemplate.startsWith('saved:')&&!saved)return;const branding=saved?brandingSnapshot(saved):{templateId:newTemplate,logoOn:true};setShows(a=>[...a,{id,title:newShow.trim(),cues:[],left:0,status:'Ready',...branding}]);setSelected(id);setNewShow('');setNewTemplate('bayer-light');setShowOpen(false);setView('workspace')}}>Create Show</Button></Modal>
 </main>
}