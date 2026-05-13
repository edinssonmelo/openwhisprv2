function IconSend({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      {/* Nudge: plane strokes read heavy top-right in a square viewBox */}
      <g transform="translate(-1.15 0.55)">
        <path
          d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

function IconCopyMsg({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M8 7.5V5a2 2 0 012-2h7a2 2 0 012 2v10a2 2 0 01-2 2h-1.5M8 7.5H6a2 2 0 00-2 2v10a2 2 0 002 2h7a2 2 0 002-2v-1.5M8 7.5h6a2 2 0 012 2v1.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MeetingAiPane({
  chatThread,
  askDraft,
  onAskDraftChange,
  onSend,
  onSendMessage,
  onCopyMessage,
}: {
  chatThread: Array<{ role: 'user' | 'assistant'; text: string }>;
  askDraft: string;
  onAskDraftChange: (v: string) => void;
  onSend: () => void;
  onSendMessage: (message: string) => void;
  onCopyMessage: (text: string) => void;
}) {
  return (
    <div className="meeting-ai">
      <div className="meeting-ai__quick">
        <button type="button" className="meeting-ai__chip" onClick={() => onSendMessage('Summarize this meeting.')}>
          Summarize
        </button>
      </div>
      <div className="meeting-ai__messages">
        {chatThread.length === 0 ? (
          <p className="meeting-ai__empty">Ask about this meeting.</p>
        ) : (
          chatThread.map((m, i) => (
            <div key={`${m.role}-${i}`} className={`meeting-ai__msg meeting-ai__msg--${m.role}`}>
              <span className="meeting-ai__msg-text">{m.text}</span>
              <button
                type="button"
                className="meeting-ai__copy-msg"
                aria-label="Copy message"
                title="Copy"
                onClick={() => onCopyMessage(m.text)}
              >
                <IconCopyMsg />
              </button>
            </div>
          ))
        )}
      </div>
      <div className="meeting-ai__compose">
        <input
          className="meeting-ai__input"
          value={askDraft}
          onChange={(e) => onAskDraftChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSend()}
          placeholder="Ask…"
          aria-label="Message to assistant"
        />
        <button type="button" className="meeting-ai__send" onClick={onSend} title="Send" aria-label="Send">
          <IconSend />
        </button>
      </div>
    </div>
  );
}
