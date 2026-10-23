import { useEffect, useState } from 'react';
import { Trash2, Zap } from 'lucide-react';
import type { Show, ShowMessage } from './data';
import { useShowFont } from './lib/font-view';

const destinations = ['dsm', 'chroma', 'display'] as const;
const colors = { White: '#ffffff', Green: '#22c55e', Red: '#ef233c', Yellow: '#facc15' };

export function MessageComposer({ show, locked, publish, drafts }: {
  show: Show; locked: boolean; publish: (message?: ShowMessage) => void; drafts: Map<string, ShowMessage>;
}) {
  // Deliberately initialized once per keyed show, never from polling updates.
  const [draft, setDraft] = useState<ShowMessage>(() => drafts.get(show.id) || (show.message
    ? { ...show.message, destinations: { ...show.message.destinations } }
    : { text: '', destinations: { dsm: false, chroma: false, display: true }, color: colors.White, flash: false }));
  useEffect(() => { drafts.set(show.id, draft); }, [draft, drafts, show.id]);
  const [custom, setCustom] = useState(draft.color || '#ffffff');
  const [customOpen, setCustomOpen] = useState(false);
  const current = show.message || draft;
  const colorChoice = customOpen && current.color === custom ? 'Custom' :
    Object.entries(colors).find(([, color]) => color === current.color)?.[0] || 'Custom';
  const isValid = (message: ShowMessage) => message.text.trim().length > 0 && message.text.length <= 500 &&
    destinations.some(destination => message.destinations[destination]);
  const valid = isValid(draft);
  const normalize = (message: ShowMessage): ShowMessage => ({ ...message,
    color: message.color ?? '#ffffff', flash: message.flash ?? false,
    destinations: { ...message.destinations, chroma: message.destinations.chroma ?? false } });
  const update = (changes: Partial<ShowMessage>) => {
    if (locked) return;
    // Formatting uses the latest published message, not a possibly stale local draft.
    const next = { ...current, ...changes };
    setDraft(next);
    if (show.message) publish(isValid(next) ? normalize(next) : undefined);
  };
  const button = 'message-tool';
  return <section aria-label='On-screen messages' className='message-editor'>
    <h3 className='sr-only'>On-screen messages</h3>
    <fieldset disabled={locked}>
      <div role='group' aria-label='Message destinations' className='message-destinations'>
        {destinations.map(destination => <button key={destination} type='button'
          aria-pressed={Boolean(current.destinations[destination])}
          onClick={() => update({ destinations: { ...current.destinations, [destination]: !current.destinations[destination] } })}
          className={button}>{destination.toUpperCase()}</button>)}
      </div>
      <label className='sr-only' htmlFor={`message-text-${show.id}`}>Message text</label>
        <textarea id={`message-text-${show.id}`} aria-label='Message text' maxLength={500} rows={3} value={draft.text}
          onChange={event => update({ text: event.target.value })}
          style={{ fontWeight: current.bold === false ? 400 : 700, textTransform: current.uppercase ? 'uppercase' : 'none' }}
          className='message-textarea'/>
      <div className='message-toolbar'>
        <button type='button' className={button} aria-label='Clear message and draft' title='Clear message and draft'
          onClick={() => { if (!locked) { setDraft({ ...current, text: '' }); publish(); } }}><Trash2 size={16}/></button>
      <div role='group' aria-label='Message color' className='message-colors'>
        {[...Object.keys(colors), 'Custom'].map(name => <button key={name} type='button' aria-label={name} title={`${name} message color`} aria-pressed={colorChoice === name}
          onClick={() => { if (!locked) { setCustomOpen(name === 'Custom'); update({ color: name === 'Custom' ? custom : colors[name as keyof typeof colors] }); } }}
          className={`${button} message-color`} style={{ textDecorationColor: name === 'Custom' ? custom : colors[name as keyof typeof colors] }}>A</button>)}
      </div>
      <button type='button' className={button} aria-label='Bold message' title='Bold message' aria-pressed={current.bold !== false}
        onClick={() => update({ bold: current.bold === false })}><b>B</b></button>
      <button type='button' className={button} aria-label='Uppercase message' title='Uppercase message' aria-pressed={Boolean(current.uppercase)}
        onClick={() => update({ uppercase: !current.uppercase })}>aA</button>
      <button type='button' aria-label='Flash message' aria-pressed={Boolean(current.flash)}
        title='Flash message' className={button}
        onClick={() => update({ flash: !current.flash })}><Zap size={15}/></button>
      <div className='message-publish'>
        <button type='button' disabled={!show.message && !valid} className={button} title='Toggle message' aria-pressed={Boolean(show.message)}
          onClick={() => { if (!locked) { if (show.message) publish(); else if (valid) publish(normalize(draft)); } }}>
          <span aria-hidden='true' className={`message-status-dot ${show.message ? 'message-status-live' : ''}`}/>Show</button>
      </div>
      </div>
      {colorChoice === 'Custom' && <label className='message-custom'>Custom message color
        <input aria-label='Custom message color' type='color' value={custom} onChange={event => {
          if (!locked) { setCustom(event.target.value); update({ color: event.target.value }); }
        }}/>
      </label>}
    </fieldset>
  </section>;
}

export function OutputMessage({ show, destination, small = false }: {
  show: Show; destination: typeof destinations[number]; small?: boolean;
}) {
  const message = show.message;
  if (show.blackout || !message?.destinations[destination] || !message.text.trim()) return null;
  return <MessageText show={show} message={message} destination={destination}
    className={`output-message ${small ? 'output-message-small' : ''}`}/>;
}

export function WorkspaceMessage({ show }: { show: Show }) {
  const message = show.message;
  const liveDestinations = destinations.filter(destination => message?.destinations[destination]);
  if (show.blackout || !message?.text.trim() || !liveDestinations.length) return null;
  return <section aria-label='Published workspace message' className='workspace-message'>
    <p className='workspace-message-destinations'>Live message · {liveDestinations.map(destination => destination.toUpperCase()).join(' · ')}</p>
    <MessageText show={show} message={message} className='workspace-message-text'/>
  </section>;
}

function MessageText({ show, message, destination, className }: {
  show: Show; message: ShowMessage; destination?: typeof destinations[number]; className: string;
}) {
  const font = useShowFont(show, 'textFont');
  return <div data-output-message={destination} data-font-role='text'
    className={`${className} ${message.flash ? 'output-message-flash' : ''}`}
    style={{ ...font, color: /^#[0-9a-f]{6}$/i.test(message.color || '') ? message.color : '#ffffff',
      fontWeight: message.bold === false ? 400 : 700 }}>
    {message.uppercase ? message.text.toUpperCase() : message.text}
  </div>;
}
