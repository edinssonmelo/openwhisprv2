import type { MeetingNotesSaveStatus } from '../../hooks/useMeetingNotes';

function IconCopySmall({ className }: { className?: string }) {
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

export function MeetingNotesPane({
  value,
  onChange,
  saveStatus,
  onCopy,
}: {
  value: string;
  onChange: (v: string) => void;
  saveStatus: MeetingNotesSaveStatus;
  onCopy: () => void;
}) {
  return (
    <div className="meeting-notes">
      <div className="meeting-notes__paper">
        <button
          type="button"
          className="meeting-notes__copy-icon"
          onClick={onCopy}
          aria-label="Copy notes"
          title="Copy notes"
        >
          <IconCopySmall />
        </button>
        {(saveStatus === 'saving' || saveStatus === 'saved') && (
          <span className="meeting-notes__status" aria-live="polite">
            {saveStatus === 'saving' ? 'Saving…' : 'Saved'}
          </span>
        )}
        <textarea
          className="meeting-notes__textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Write meeting notes…"
          spellCheck
          aria-label="Meeting notes"
        />
      </div>
    </div>
  );
}
