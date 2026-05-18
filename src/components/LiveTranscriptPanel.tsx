import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TranscriptBrandIcon } from './TranscriptBrandIcon';

const COPY_OK_MS = 2200;

const NEAR_BOTTOM_PX = 56;

function isScrollNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}

interface LiveTranscriptPanelProps {
  text: string;
  refinedText?: string;
  activeView: 'live' | 'refined';
  onViewChange: (view: 'live' | 'refined') => void;
  refinementAvailable: boolean;
  /** Short status for footer (e.g. Escuchando / Procesando). */
  footerStatusLabel: string;
  /** Optional one-line capture hint (e.g. mic + system). */
  listeningHint?: string;
  onCopy: () => boolean | Promise<boolean>;
  /** Oculta el panel al chip lateral (solo overlay expandido). */
  onMinimize?: () => void;
}

function CopyIcon() {
  return (
    <svg fill="none" viewBox="0 0 24 24" aria-hidden>
      <rect height="13" rx="2.5" ry="2.5" stroke="currentColor" strokeWidth="2" width="13" x="9" y="9" />
      <path
        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Marca de copiado: trazo grueso + curva suave (solo glifo, sin tocar el chrome del botón). */
function CheckIcon() {
  return (
    <svg fill="none" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12 3.75a8.25 8.25 0 1 1 0 16.5 8.25 8.25 0 0 1 0-16.5Z"
        stroke="currentColor"
        strokeWidth="1.35"
        opacity="0.35"
      />
      <path
        d="M7.35 12.1 10.65 15.4 16.65 8.6"
        stroke="currentColor"
        strokeWidth="2.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MinimizeTranscriptIcon() {
  return (
    <svg fill="none" height="17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.1" viewBox="0 0 24 24" width="17" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function WaveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="14" aria-hidden>
      <line x1="4" x2="4" y1="21" y2="14" />
      <line x1="4" x2="4" y1="10" y2="3" />
      <line x1="12" x2="12" y1="21" y2="12" />
      <line x1="12" x2="12" y1="8" y2="3" />
      <line x1="20" x2="20" y1="21" y2="16" />
      <line x1="20" x2="20" y1="12" y2="3" />
      <line x1="1" x2="7" y1="14" y2="14" />
      <line x1="9" x2="15" y1="8" y2="8" />
      <line x1="17" x2="23" y1="16" y2="16" />
    </svg>
  );
}

export function LiveTranscriptPanel({
  text,
  refinedText = '',
  activeView,
  onViewChange,
  refinementAvailable,
  footerStatusLabel,
  listeningHint,
  onCopy,
  onMinimize,
}: LiveTranscriptPanelProps) {
  const displayText = activeView === 'refined' ? refinedText : text;
  const scrollRef = useRef<HTMLDivElement>(null);
  const copyOkTimerRef = useRef(0);
  const [copyOk, setCopyOk] = useState(false);
  /** Si true, cada actualización de texto hace scroll al final; el usuario lo desactiva al subir y lo reactiva al volver al fondo. */
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    stickToBottomRef.current = true;
  }, [activeView]);

  useEffect(() => {
    return () => window.clearTimeout(copyOkTimerRef.current);
  }, []);

  const handleCopy = async () => {
    const ok = await Promise.resolve(onCopy());
    if (!ok) return;
    setCopyOk(true);
    window.clearTimeout(copyOkTimerRef.current);
    copyOkTimerRef.current = window.setTimeout(() => {
      setCopyOk(false);
      copyOkTimerRef.current = 0;
    }, COPY_OK_MS);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = isScrollNearBottom(el);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [displayText, activeView]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <section className="glass-panel glass-panel-float transcript-floating-panel">
      <header className="transcript-panel-head" data-session-drag-region="true">
        <div className="transcript-panel-head-title">
          <TranscriptBrandIcon className="transcript-panel-icon" size={22} />
          <h2 className="transcript-panel-heading">Transcripción</h2>
        </div>
        <div className="transcript-panel-head-actions">
          {refinementAvailable ? (
            <div className="glass-segmented glass-segmented-compact" aria-label="Vista de transcripción">
              <button
                type="button"
                className={activeView === 'live' ? 'active' : ''}
                onClick={() => onViewChange('live')}
              >
                En vivo
              </button>
              <button
                type="button"
                className={activeView === 'refined' ? 'active' : ''}
                onClick={() => onViewChange('refined')}
              >
                Refinada
              </button>
            </div>
          ) : null}
          {onMinimize ? (
            <button
              type="button"
              className="glass-button-icon transcript-copy-btn transcript-minimize-btn"
              onClick={onMinimize}
              title="Ocultar panel de transcripción"
              aria-label="Ocultar panel de transcripción"
            >
              <MinimizeTranscriptIcon />
            </button>
          ) : null}
          <button
            type="button"
            className="glass-button-icon transcript-copy-btn"
            onClick={() => void handleCopy()}
            disabled={!displayText.trim()}
            title={copyOk ? 'Copiada' : 'Copiar transcripción'}
            aria-label={copyOk ? 'Transcripción copiada' : 'Copiar transcripción'}
          >
            {copyOk ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="transcript-panel-body custom-scrollbar"
        aria-live="polite"
        onScroll={onScroll}
      >
        {displayText.trim() ? (
          <p className="transcript-panel-text">{displayText}</p>
        ) : (
          <p className="transcript-panel-placeholder">La transcripción aparecerá aquí cuando empieces a grabar.</p>
        )}
      </div>

      <footer className="transcript-panel-foot">
        <div className="transcript-foot-lines">
          <span className="transcript-foot-status">{footerStatusLabel}</span>
          {listeningHint ? <span className="transcript-foot-hint">{listeningHint}</span> : null}
        </div>
        <span className="transcript-foot-engine">
          <WaveIcon />
          Whisper Large V3 Turbo
        </span>
      </footer>
    </section>
  );
}
