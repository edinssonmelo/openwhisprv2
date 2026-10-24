import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Language } from './locale';
import './experience.css';

const text = {
 es: { transcript:'Transcripción', response:'Respuesta IA', pause:'Pausar demo', play:'Reanudar demo', hideAI:'Ocultar IA', showAI:'Mostrar IA', hide:'Ocultar', show:'Mostrar paneles', home:'Reiniciar demo', copy:'Copiar', copied:'Copiado', close:'Cerrar IA', listening:'Escuchando', paused:'En pausa', audio:'Micrófono y audio del sistema', placeholder:'Pregunta algo sobre lo que se está diciendo…', hint:'Escribe una pregunta o pulsa Enter para pedir ayuda sobre lo último dicho. Verifica la IA local en configuración si no responde.', question:'¿Qué hemos acordado?', answer:'La primera versión se centrará en capturar el micrófono y el audio del sistema, transcribir en el equipo y conservar las sesiones para consultarlas después.', send:'Enviar pregunta de ejemplo', collapse:'Contraer transcripción', expand:'Expandir transcripción', demo:'Demo animada de la interfaz. No graba audio ni consulta un modelo de IA.', words:'Hola, esta es una prueba de micrófono. Aquí podría estar transcribiendo una reunión cualquiera y puedo ir tomando notas, preguntando a la inteligencia artificial. Para la primera versión, vamos a capturar el micrófono y el audio del sistema, guardar la transcripción en el equipo y volver a las sesiones cuando necesitemos consultar los detalles.' },
 en: { transcript:'Transcription', response:'AI response', pause:'Pause preview', play:'Resume preview', hideAI:'Hide AI', showAI:'Show AI', hide:'Hide', show:'Show panels', home:'Restart preview', copy:'Copy', copied:'Copied', close:'Close AI', listening:'Listening', paused:'Paused', audio:'Microphone and system audio', placeholder:'Ask about what is being said…', hint:'Type a question or press Enter to ask for help with what was just said. Check your local AI settings if it does not respond.', question:'What have we agreed?', answer:'The first release will focus on capturing microphone and system audio, transcribing on the device, and saving sessions so they can be reviewed later.', send:'Send example question', collapse:'Collapse transcription', expand:'Expand transcription', demo:'Animated interface demo. It does not record audio or call an AI model.', words:'Hello, this is a microphone test. I could be transcribing a meeting here, taking notes and asking the AI questions as the conversation continues. For the first release, we will capture microphone and system audio, save the transcript on the computer, and revisit our sessions whenever we need to check the details.' }
};
function Icon({name}: {name:string}) {
 const paths: Record<string, React.ReactNode> = {
  doc:<><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h4M10 12h5M10 16h5"/></>,
  copy:<><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M15 8V4H4v12h4"/></>,
  down:<path d="m6 9 6 6 6-6"/>, close:<path d="m6 6 12 12M6 18 18 6"/>,
  home:<><path d="m3 10 9-7 9 7M6 9v12h12V9"/><path d="M10 21v-7h4v7"/></>,
  send:<><path d="m3 10 18-7-7 18-4-7-7-4Z"/><path d="m10 14 11-11"/></>,
  sliders:<><path d="M5 4v16M12 4v16M19 4v16M2 9h6M9 15h6M16 7h6"/></>,
  sparkle:<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z"/>,
  pause:<><path d="M8 6v12M16 6v12"/></>,play:<path d="m8 5 11 7-11 7z"/>,
 };
 return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export default function Experience({language}: {language: Language}) {
 const t = text[language];
 const words = t.words.split(' ');
 const [playing, setPlaying] = useState(() => !reducedMotion());
 const [count, setCount] = useState(() => reducedMotion() ? 999 : 20);
 const [elapsed, setElapsed] = useState(27);
 const [ai, setAI] = useState(true);
 const [hidden, setHidden] = useState(false);
 const [collapsed, setCollapsed] = useState(false);
 const [question, setQuestion] = useState('');
 const [answer, setAnswer] = useState(false);
 const [answerCount, setAnswerCount] = useState(0);
 const [copied, setCopied] = useState('');
 const body = useRef<HTMLDivElement>(null);
 const transcript = words.slice(0, count).join(' ');
 useEffect(() => {
  if (!playing) return;
  const tick = window.setInterval(() => setCount(n => n >= words.length + 16 ? 20 : n + 1), 150);
  const clock = window.setInterval(() => setElapsed(n => n + 1), 1000);
  return () => { clearInterval(tick); clearInterval(clock); };
 }, [playing, words.length]);
 useEffect(() => {
  const preference=window.matchMedia('(prefers-reduced-motion: reduce)');
  const update=()=>{if(preference.matches){setPlaying(false);setCount(999);setAnswerCount(999);}};
  preference.addEventListener('change',update);return ()=>preference.removeEventListener('change',update);
 },[]);
 useEffect(() => { if(body.current) body.current.scrollTop=body.current.scrollHeight; },[count]);
 useEffect(() => {
  if(!answer) return;
  if(reducedMotion()){setAnswerCount(999);return;}
  if(answerCount>=t.answer.length)return;
  const timer=setTimeout(()=>setAnswerCount(n=>n+2),30);return()=>clearTimeout(timer);
 },[answer,answerCount,t.answer.length]);
 useEffect(() => { if(!copied)return;const timer=setTimeout(()=>setCopied(''),1800);return()=>clearTimeout(timer); },[copied]);
 const copy = async (kind:string,value:string) => {try {await navigator.clipboard.writeText(value);setCopied(kind);}catch{setCopied('');}};
 const ask = (event:FormEvent) => {event.preventDefault();setAnswer(true);setAnswerCount(0);setQuestion('');};
 const reset=()=>{setCount(reducedMotion()?999:20);setElapsed(27);setAI(true);setHidden(false);setCollapsed(false);setAnswer(false);setQuestion('');setPlaying(!reducedMotion());};
 return <><div className={`ow-scene ${playing?'ow-playing':''} ${!ai?'ow-no-ai':''}`} id="experience" aria-label={t.demo}>
  <div className="ow-wallpaper"/>
  <div className="ow-toolbar ow-glass">
   <button className="ow-pause" onClick={()=>setPlaying(v=>!v)} aria-label={playing?t.pause:t.play}><Icon name={playing?'pause':'play'}/></button>
   <span className="ow-meter" aria-hidden="true">{Array.from({length:27},(_,i)=><i key={i} style={{'--h':`${3+(i*7)%14}px`,'--d':`${i*-.12}s`} as React.CSSProperties}/>)}</span>
   <time>{String(Math.floor(elapsed/60)).padStart(2,'0')}:{String(elapsed%60).padStart(2,'0')}</time>
   <button className="ow-button ow-ai-toggle" onClick={()=>setAI(v=>!v)}>{ai?t.hideAI:t.showAI}<kbd>⌘ ↵</kbd></button>
   <button className="ow-button ow-visibility" onClick={()=>setHidden(v=>!v)}>{hidden?t.show:t.hide}<kbd>⌘ \</kbd></button>
   <button className="ow-button ow-home" onClick={reset} aria-label={t.home}><Icon name="home"/></button>
  </div>
  {!hidden && <section className={`ow-transcription ow-glass ${collapsed?'ow-collapsed':''}`} aria-label={t.transcript}>
   <header className="ow-panel-header"><div><Icon name="doc"/><h3>{t.transcript}</h3></div><div className="ow-actions"><button onClick={()=>setCollapsed(v=>!v)} aria-label={collapsed?t.expand:t.collapse}><Icon name="down"/></button><button onClick={()=>copy('transcript',transcript)} aria-label={copied==='transcript'?t.copied:t.copy}><Icon name="copy"/></button></div></header>
   {!collapsed && <><div className="ow-transcript-body" ref={body}><p>{transcript}<span className="ow-caret" aria-hidden="true"/></p></div><footer className="ow-transcript-footer"><div><span className="ow-listening-dot"/>{playing?t.listening:t.paused}<small>{t.audio}</small></div><div className="ow-engine"><Icon name="sliders"/><span>Parakeet TDT<br/>Local AI</span></div></footer></>}
  </section>}
  {!hidden && ai && <section className="ow-ai ow-glass" aria-label={t.response}>
   <header className="ow-panel-header"><div className="ow-ai-title"><Icon name="sparkle"/><h3>{t.response}</h3></div><div className="ow-actions"><button className="ow-copy-answer" onClick={()=>copy('answer',answer?t.answer:t.hint)}>{copied==='answer'?t.copied:t.copy}</button><button onClick={()=>setAI(false)} aria-label={t.close}><Icon name="close"/></button></div></header>
   <div className="ow-ai-body">{answer?<p className="ow-answer">{t.answer.slice(0,answerCount)}<span className="ow-caret" aria-hidden="true"/></p>:<p>{t.hint}</p>}</div>
   <form className="ow-prompt" onSubmit={ask}><input value={question} onChange={e=>setQuestion(e.target.value)} placeholder={t.placeholder} aria-label={t.placeholder}/><button type="submit" aria-label={t.send}><Icon name="send"/></button></form>
  </section>}
 </div><div className="ow-demo-caption"><span>{t.demo}</span><button onClick={()=>{setAI(true);setHidden(false);setAnswer(true);setAnswerCount(0);}}>{t.question} ↗</button></div></>;
}
