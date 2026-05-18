import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { AssistantChatMessage } from './AssistantChatPanel';

const AI_NEAR_BOTTOM_PX = 56;

function aiScrollNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= AI_NEAR_BOTTOM_PX;
}

interface AiOverlayPanelProps {
  open: boolean;
  messages: AssistantChatMessage[];
  input: string;
  busy: boolean;
  error: string | null;
  localAiReady: boolean;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onCopyLastResponse: () => void;
}

function UserPromptIcon() {
  return (
    <svg fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="16" aria-hidden>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function AiSparkIcon({ gradientId }: { gradientId: string }) {
  return (
    <svg fill="none" height="16" stroke={`url(#${gradientId})`} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="16" aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="100%">
          <stop offset="0%" stopColor="#4BFBBA" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="16" aria-hidden>
      <line x1="22" x2="11" y1="2" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="14" aria-hidden>
      <line x1="18" x2="6" y1="6" y2="18" />
      <line x1="6" x2="18" y1="6" y2="18" />
    </svg>
  );
}

export function AiOverlayPanel({
  open,
  messages,
  input,
  busy,
  error,
  localAiReady,
  onInputChange,
  onSubmit,
  onClose,
  onCopyLastResponse,
}: AiOverlayPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const rawId = useId();
  const gradientId = `ai-grad-${rawId.replace(/[:]/g, '')}`;
  const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant');

  useEffect(() => {
    if (open) {
      stickToBottomRef.current = true;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(id);
  }, [open]);

  const onMessagesScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = aiScrollNearBottom(el);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [open, messages, busy, error]);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  if (!open) return null;

  return (
    <aside className="glass-panel glass-panel-float ai-floating-panel" aria-label="Respuesta IA">
      <header className="ai-panel-head" data-session-drag-region="true">
        <div className="ai-panel-head-title">
          <AiSparkIcon gradientId={gradientId} />
          <h2 className="ai-panel-heading gradient-accent-text">Respuesta IA</h2>
        </div>
        <div className="ai-panel-head-actions">
          <button
            type="button"
            className="glass-button-tiny"
            disabled={!lastAssistantMessage}
            onClick={onCopyLastResponse}
          >
            Copiar
          </button>
          <button type="button" className="glass-button-icon" onClick={onClose} aria-label="Cerrar respuesta IA">
            <CloseIcon />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="ai-panel-body custom-scrollbar" onScroll={onMessagesScroll}>
        {messages.length === 0 ? (
          <p className="ai-panel-hint">
            Escribe una pregunta o pulsa Enter para pedir ayuda sobre lo último dicho.
            {!localAiReady ? ' · Verifica la IA local en configuración si no responde.' : null}
          </p>
       ) : (
          messages.slice(-12).map((message) => (
            <div
              key={message.id}
              className={`ai-conv-row ${message.role === 'user' ? 'ai-conv-user' : 'ai-conv-assistant'}`}
            >
              <div className="ai-conv-icon" aria-hidden>
                {message.role === 'user' ? <UserPromptIcon /> : <AiSparkIcon gradientId={`${gradientId}-a-${message.id.replace(/[^a-zA-Z0-9_-]/g, '')}`} />}
              </div>
              <p className="ai-conv-text">{message.text}</p>
            </div>
          ))
        )}
        {error ? <p className="ai-panel-error">{error}</p> : null}
        {busy ? <p className="ai-panel-busy">Pensando…</p> : null}
      </div>

      <form
        className="ai-panel-input-wrap"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="glass-input-wrap">
          <input
            ref={inputRef}
            className="glass-input"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="Pregunta algo sobre lo que se está diciendo…"
            disabled={busy}
            aria-busy={busy}
          />
          <button type="submit" className="gradient-accent-btn ai-send-btn" disabled={busy} aria-label="Enviar">
            <SendIcon />
          </button>
        </div>
      </form>
    </aside>
  );
}
