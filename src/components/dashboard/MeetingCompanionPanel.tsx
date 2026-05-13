import type { MeetingNotesSaveStatus } from '../../hooks/useMeetingNotes';
import { MeetingAiPane } from './MeetingAiPane';
import { MeetingNotesPane } from './MeetingNotesPane';

export function MeetingCompanionPanel({
  tab,
  onTabChange,
  notesText,
  notesSaveStatus,
  onNotesChange,
  onCopyNotes,
  chatThread,
  askDraft,
  onAskDraftChange,
  onSend,
  onSendMessage,
  onCopyMessage,
  showTabs = true,
  className,
  rootHtmlId,
}: {
  tab: 'notes' | 'ai';
  onTabChange: (t: 'notes' | 'ai') => void;
  notesText: string;
  notesSaveStatus: MeetingNotesSaveStatus;
  onNotesChange: (v: string) => void;
  onCopyNotes: () => void;
  chatThread: Array<{ role: 'user' | 'assistant'; text: string }>;
  askDraft: string;
  onAskDraftChange: (v: string) => void;
  onSend: () => void;
  onSendMessage: (message: string) => void;
  onCopyMessage: (text: string) => void;
  showTabs?: boolean;
  className?: string;
  /** When false, omit id (e.g. floating dock sets id on outer aside). */
  rootHtmlId?: string | false;
}) {
  const rootClass = [
    'meeting-companion',
    !showTabs ? 'meeting-companion--no-tabs' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const panelId = rootHtmlId === false ? undefined : (rootHtmlId ?? 'meeting-companion-panel');
  const idProps = panelId ? { id: panelId } : {};

  return (
    <div {...idProps} className={rootClass}>
      {showTabs ? (
        <div className="meeting-companion__tabs" role="tablist" aria-label="Notes and assistant">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'notes'}
            className={`meeting-companion__tab ${tab === 'notes' ? 'is-active' : ''}`}
            onClick={() => onTabChange('notes')}
          >
            Notes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'ai'}
            className={`meeting-companion__tab ${tab === 'ai' ? 'is-active' : ''}`}
            onClick={() => onTabChange('ai')}
          >
            Ask AI
          </button>
        </div>
      ) : null}
      <div className="meeting-companion__content" role="tabpanel">
        {tab === 'notes' ? (
          <MeetingNotesPane value={notesText} onChange={onNotesChange} saveStatus={notesSaveStatus} onCopy={onCopyNotes} />
        ) : (
          <MeetingAiPane
            chatThread={chatThread}
            askDraft={askDraft}
            onAskDraftChange={onAskDraftChange}
            onSend={onSend}
            onSendMessage={onSendMessage}
            onCopyMessage={onCopyMessage}
          />
        )}
      </div>
    </div>
  );
}
