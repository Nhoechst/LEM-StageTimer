import { useEffect, useState } from 'react';
import type { Show } from '../data';
import { cueType, formatTimer } from './timer.js';
import { useShowFont } from './font-view';

export function TimerValue({show}: {show: Show}) {
  const clock = cueType(show) === 'clock';
  const font = useShowFont(show, 'timerFont');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!clock) return;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 200);
    return () => window.clearInterval(timer);
  }, [clock]);
  const text = formatTimer(show, clock ? now : undefined);
  return <span data-font-role="timer" className={clock ? 'local-time-value whitespace-nowrap' : undefined} style={{...font, ...(clock ? {fontSize: 'min(1em, 9vw)'} : {})}}>{text}</span>;
}
