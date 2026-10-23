import { Show, TEMPLATE_LIST } from './data';
import { cueType } from './lib/timer.js';
import { TimerValue } from './lib/timer-view';
import { displayLogo } from './lib/branding.js';
import { useShowFont } from './lib/font-view';
import { OutputMessage } from './Messages';
import { useLayoutEffect, useRef } from 'react';
import { useDatabase } from './lib/database';
import type { ReactNode } from 'react';
function OutputText({ show, children }: { show: Show; children: ReactNode }) {
 const style = useShowFont(show, 'textFont');
 return <span data-font-role="text" style={style}>{children}</span>;
}
export function BrandMark({compact=false,uploaded=''}:{compact?:boolean;uploaded?:string}){if(uploaded)return <img src={uploaded} alt='Uploaded logo' className={compact?'h-10 w-10 rounded-full object-contain':'h-12 max-w-[145px] object-contain'} />;return <div aria-label='Bayer-style placeholder wordmark' className={compact?'grid h-10 w-10 place-items-center rounded-full border-4 border-[#0069b4] text-[10px] font-black text-[#007a78]':'rounded-full border-4 border-[#0069b4] bg-white px-4 py-2 text-sm font-black tracking-wide text-[#007a78]'}>BAYER</div>}
export function TemplatePicker({value,onChange,disabled=false,compact=false}:{value:string;onChange:(id:string)=>void;disabled?:boolean;compact?:boolean}){return <div className={compact?'space-y-2':'grid gap-2 sm:grid-cols-3'}>{TEMPLATE_LIST.map(t=><button key={t.id} disabled={disabled} onClick={()=>onChange(t.id)} className={`rounded-xl border p-2 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${value===t.id?'border-[#0069b4] ring-2 ring-[#b8dfda]':'border-slate-200 hover:border-[#0069b4]'}`}><div className={`h-9 rounded-lg border ${t.mini} p-1.5`}><span className='block h-1.5 w-8 rounded bg-white/70'/><span className='mt-2 block h-1 w-14 rounded bg-white/60'/></div><b className='mt-2 block text-sm'>{t.name}</b><span className='mt-0.5 block text-xs leading-4 text-slate-500'>{t.description}</span></button>)}</div>}
export function CountdownUrgencyBar({show}:{show:Show}){
 const {timerVersion}=useDatabase(), version=timerVersion(show.id);
 const bar=useRef<HTMLDivElement>(null);
 const clock=useRef<{key:string;version:string;status:string;left:number;deadline:number;target:number;frame:number}|null>(null);
 const active=show.cues.find(c=>c.id===show.active);
 const type=cueType(show);
 const duration=active?.duration??0, inactive=!active||duration<=0, remaining=Math.max(0,show.left);
 const expired=!inactive&&remaining===0;
 useLayoutEffect(()=>{
  if(type!=='countdown'||inactive||expired){clock.current=null;return;}
  const node=bar.current;
  if(!node)return;
  const now=performance.now(), key=JSON.stringify([show.id,show.active,duration]);
  let anchor=clock.current;
  // Repeated rounded samples are not clock resets. Timer versions also identify
  // explicit same-value restarts, without depending on metadata/revision changes.
  if(!anchor||anchor.key!==key||anchor.version!==version||anchor.status!==show.status||
    remaining>anchor.left||remaining<(anchor.deadline-now)/1000-2){
   anchor={key,version,status:show.status,left:remaining,deadline:now+remaining*1000,target:now+remaining*1000,frame:now};
   clock.current=anchor;
  }else if(anchor.left!==remaining){
   anchor.left=remaining;
   // ceil(server remaining) defines a one-second uncertainty window. Correct
   // only outside it, slewing the visual deadline rather than jumping each poll.
   anchor.target=Math.max(now+(remaining-1)*1000,Math.min(now+remaining*1000,anchor.target));
  }
  const current=anchor, motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame=0;
  const paint=(time:number)=>{
   const elapsed=Math.max(0,time-current.frame);
   const correction=Math.max(-elapsed*.25,Math.min(elapsed*.25,current.target-current.deadline));
   current.deadline+=correction;
   current.frame=time;
   const seconds=show.status==='Running'&&!motion.matches?Math.max(.001,(current.deadline-time)/1000):remaining;
   const edge=(1-Math.min(1,seconds/duration))*50;
   node.style.clipPath=`inset(0 ${edge}% 0 ${edge}%)`;
  };
  const tick=(time:number)=>{paint(time);frame=requestAnimationFrame(tick);};
  const start=()=>{
   cancelAnimationFrame(frame);
   paint(performance.now());
   if(show.status==='Running'&&!motion.matches)frame=requestAnimationFrame(tick);
  };
  start();
  motion.addEventListener('change',start);
  return ()=>{cancelAnimationFrame(frame);motion.removeEventListener('change',start);};
 },[show.id,show.active,show.status,version,type,duration,inactive,expired,remaining]);
 if(type!=='countdown')return null;
 const gradient='linear-gradient(90deg,#39845b 0%,#39845b 41%,#ad7b27 41%,#ad7b27 48%,#ae3f3f 48%,#ae3f3f 52%,#ad7b27 52%,#ad7b27 59%,#39845b 59%,#39845b 100%)';
 return <div aria-hidden='true' className='pointer-events-none absolute inset-x-0 bottom-0 z-10'>{!inactive&&!expired&&<div ref={bar} data-countdown-bar className='h-2 w-full sm:h-3' style={{backgroundImage:gradient,opacity:.84}}/>}{expired&&<div data-countdown-expired className='h-2 w-full bg-[#ef233c] [animation:pulse_500ms_ease-in-out_infinite] motion-reduce:animate-none sm:h-3'/>}</div>;
}
export function DsmSurface({show,fullscreen=false,digitBlack=false}:{show:Show;fullscreen?:boolean;digitBlack?:boolean}){
 if(show.blackout)return <section aria-label='Blackout active' className={`min-h-full bg-black ${fullscreen?'min-h-screen':'min-h-[70vh] rounded-2xl'}`}/>;
 return <section aria-label='DSM output' className={`relative overflow-hidden bg-transparent ${fullscreen?'min-h-screen rounded-none p-10 pb-24 pr-12':'min-h-[70vh] rounded-2xl p-8 pb-16'}`}><OutputMessage show={show} destination='dsm'/><span className={`absolute bottom-10 right-12 font-mono text-5xl font-bold sm:text-7xl ${digitBlack?'text-black':'text-white'}`}><TimerValue show={show}/></span><CountdownUrgencyBar show={show}/></section>;
}
export function DisplayPreview({show,activeName,thumbnail=false}:{show:Show;activeName?:string;thumbnail?:boolean}){
 if(show.blackout)return <div aria-label='Display blackout preview' className='aspect-video w-full rounded-md bg-black shadow-inner'/>;
 const t=TEMPLATE_LIST.find(x=>x.id===show.templateId)||TEMPLATE_LIST[0], time=<TimerValue show={show}/>;
 if(thumbnail)return <div aria-label='Live normal display thumbnail' className={`relative aspect-video w-full overflow-hidden rounded-md border border-white/20 shadow-inner ${t.surface}`}><div className='absolute inset-x-0 top-0 h-px bg-[#007a78]'/><OutputMessage show={show} destination='display' small/><div className='grid h-full place-items-center px-3 text-center'><p className={`font-mono text-[10px] font-bold sm:text-xs ${t.timer}`}>{time}</p></div><CountdownUrgencyBar show={show}/></div>;
 return <DisplaySurface show={show} activeName={activeName} preview/>;
}
export function DisplaySurface({show,activeName,preview=false}:{show:Show;activeName?:string;preview?:boolean}){
 if(show.blackout)return <section aria-label='Blackout active' className='min-h-[70vh] rounded-2xl bg-black shadow-xl'/>;
 const t=TEMPLATE_LIST.find(x=>x.id===show.templateId)||TEMPLATE_LIST[0];
 return <section aria-label={preview?'Live normal display preview':undefined}
   className={`relative grid place-items-center overflow-hidden text-center ${preview?'display-preview aspect-video w-full rounded-lg shadow-inner':'min-h-[70vh] rounded-2xl p-8 pb-12 shadow-xl'} ${t.surface}`}>
   <div className='absolute inset-x-0 top-0 h-2 bg-[#007a78]'/>
   <OutputMessage show={show} destination='display'/>
   {show.logoOn&&<div className={preview?'display-preview-logo':'absolute left-7 top-7'}><BrandMark uploaded={displayLogo(show)}/></div>}
   <div>
     <p className='display-cue mb-5 text-lg font-semibold opacity-80'><OutputText show={show}>{activeName||'Timer'}</OutputText></p>
     <p className={`display-timer font-mono text-7xl font-bold sm:text-9xl ${t.timer}`}><TimerValue show={show}/></p>
     <p className='display-status mt-5 text-sm font-bold tracking-widest opacity-75'><OutputText show={show}>{cueType(show)==='clock'?'LOCAL TIME':show.status.toUpperCase()}</OutputText></p>
   </div><CountdownUrgencyBar show={show}/>
 </section>;
}