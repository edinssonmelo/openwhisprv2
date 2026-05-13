export interface AssistantChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

interface AssistantChatPanelProps {
  messages: AssistantChatMessage[];
  input: string;
  busy: boolean;
  error: string | null;
  localAiReady: boolean;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
}

/** Panel alternativo con mismos tokens glass que el overlay (no usado en la vista principal). */
export function AssistantChatPanel({
  messages,
  input,
  busy,
  error,
  localAiReady,
  onInputChange,
  onSubmit,
}: AssistantChatPanelProps) {
  return (
    <section className="glass-panel glass-panel-float ai-floating-panel">
      <div className="ai-panel-head">
        <div className="ai-panel-head-title">
          <h2 className="ai-panel-heading gradient-accent-text">Pregúntale a la IA</h2>
        </div>
        <span className="transcript-foot-engine" style={{ fontSize: 12 }}>
          {localAiReady ? 'IA local lista' : 'IA local no disponible'}
        </span>
      </div>
      <div className="ai-panel-body custom-scrollbar">
        {messages.length === 0 ? (
          <p className="ai-panel-hint">Pregunta algo sobre lo que se ha dicho…</p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`ai-conv-row ${message.role === 'user' ? 'ai-conv-user' : 'ai-conv-assistant'}`}>
              <p className="ai-conv-text">{message.text}</p>
            </div>
          ))
        )}
        {error ? <p className="ai-panel-error">{error}</p> : null}
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
            className="glass-input"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="Resume lo importante…"
            disabled={busy}
          />
          <button type="submit" className="gradient-accent-btn ai-send-btn" disabled={busy || !input.trim()} aria-label="Enviar">
            →
          </button>
        </div>
      </form>
    </section>
  );
}
