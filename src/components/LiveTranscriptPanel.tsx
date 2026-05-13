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
  onCopy: () => void;
}

function TranscriptDocIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="20" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" x2="8" y1="13" y2="13" />
      <line x1="16" x2="8" y1="17" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="18" aria-hidden>
      <rect height="13" rx="2" ry="2" width="13" x="9" y="9" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
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
}: LiveTranscriptPanelProps) {
  const displayText = activeView === 'refined' ? refinedText : text;

  return (
    <section className="glass-panel glass-panel-float transcript-floating-panel">
      <header className="transcript-panel-head" data-session-drag-region="true">
        <div className="transcript-panel-head-title">
          <TranscriptDocIcon className="transcript-panel-icon" />
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
          <button
            type="button"
            className="glass-button-icon"
            onClick={onCopy}
            disabled={!displayText.trim()}
            title="Copiar transcripción"
            aria-label="Copiar transcripción"
          >
            <CopyIcon />
          </button>
        </div>
      </header>

      <div className="transcript-panel-body custom-scrollbar" aria-live="polite">
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
