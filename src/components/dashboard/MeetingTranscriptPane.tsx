import { useState } from 'react';
import type { DashboardSessionSummary } from '../../types/dashboardSession';
import { copyToClipboard } from '../../utils/copyToClipboard';
import { getMeetingSummaryCopyText, getSessionCopyText } from '../../utils/meetingDetailCopy';

function IconCopy({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M8 7.5V5a2 2 0 012-2h7a2 2 0 012 2v10a2 2 0 01-2 2h-1.5M8 7.5H6a2 2 0 00-2 2v10a2 2 0 002 2h7a2 2 0 002-2v-1.5M8 7.5h6a2 2 0 012 2v1.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSummary({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 4h9l3 3v13a1 1 0 01-1 1H6a1 1 0 01-1-1V5a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
      <path d="M9 12h6M9 8h6M9 16h4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function InlineSpinner({ className }: { className?: string }) {
  return <span className={`dashboard-inline-spinner ${className ?? ''}`} aria-hidden />;
}

function summaryBodyText(session: DashboardSessionSummary): string {
  const fromMeeting = session.meetingSummary?.trim();
  if (fromMeeting) return fromMeeting;
  const line = session.refinedSummaryLine?.trim() || session.refinedText?.trim();
  if (line) return line;
  const t = session.transcriptText?.trim() || session.transcriptPreview?.trim();
  return t || '';
}

export function MeetingTranscriptPane({
  session,
  onNotify,
  className,
}: {
  session: DashboardSessionSummary;
  onNotify?: (message: string) => void;
  className?: string;
}) {
  const [copyTranscriptPending, setCopyTranscriptPending] = useState(false);
  const [copySummaryPending, setCopySummaryPending] = useState(false);

  const summaryText = summaryBodyText(session);
  const showRefinedSection =
    Boolean(session.refinedText?.trim()) && !session.meetingSummary?.trim();

  const onCopyTranscript = async () => {
    if (copyTranscriptPending) return;
    const t = getSessionCopyText(session);
    if (!t) {
      onNotify?.('Nothing to copy.');
      return;
    }
    setCopyTranscriptPending(true);
    try {
      const ok = await copyToClipboard(t);
      onNotify?.(ok ? 'Transcript copied.' : 'Could not copy.');
    } finally {
      setCopyTranscriptPending(false);
    }
  };

  const onCopySummary = async () => {
    if (copySummaryPending) return;
    const s = getMeetingSummaryCopyText(session);
    if (!s) {
      onNotify?.('No summary for this meeting.');
      return;
    }
    setCopySummaryPending(true);
    try {
      const ok = await copyToClipboard(s);
      onNotify?.(ok ? 'Summary copied.' : 'Could not copy.');
    } finally {
      setCopySummaryPending(false);
    }
  };

  return (
    <div className={className ? `meeting-transcript ${className}` : 'meeting-transcript'}>
      <div className="meeting-transcript__actions">
        <button
          type="button"
          className="meeting-transcript__action"
          onClick={() => void onCopyTranscript()}
          disabled={copyTranscriptPending}
          title="Copy full transcript"
        >
          {copyTranscriptPending ? <InlineSpinner /> : <IconCopy />}
          <span>Copy transcript</span>
        </button>
        <button
          type="button"
          className="meeting-transcript__action"
          onClick={() => void onCopySummary()}
          disabled={copySummaryPending}
          title="Copy summary"
        >
          {copySummaryPending ? <InlineSpinner /> : <IconSummary />}
          <span>Copy summary</span>
        </button>
      </div>
      <div className="meeting-transcript__body">
        <div className="meeting-transcript__section meeting-transcript__section--summary">
          <h4 className="meeting-transcript__section-label">Summary</h4>
          {summaryText ? (
            <p className="meeting-transcript__summary-body">{summaryText}</p>
          ) : (
            <p className="meeting-transcript__plain meeting-transcript__muted">No summary yet.</p>
          )}
          {session.nextStepsLine ? <p className="meeting-transcript__next">{session.nextStepsLine}</p> : null}
        </div>

        <div className="meeting-transcript__section">
          <h4 className="meeting-transcript__section-label">Transcripción</h4>
          {session.dialogueLines && session.dialogueLines.length > 0 ? (
            <div className="meeting-transcript__dialogue">
              {session.dialogueLines.map((line, i) => (
                <p key={`${line.speaker}-${i}`}>
                  <span className="meeting-transcript__speaker">{line.speaker}:</span> {line.text}
                </p>
              ))}
            </div>
          ) : (
            <p className="meeting-transcript__plain">
              {session.transcriptText?.trim() || session.transcriptPreview?.trim() || 'Sin transcripción.'}
            </p>
          )}
        </div>

        {showRefinedSection ? (
          <div className="meeting-transcript__section meeting-transcript__section--refined">
            <h4 className="meeting-transcript__section-label">Refinado</h4>
            <p className="meeting-transcript__plain meeting-transcript__plain--refined">{session.refinedText}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
