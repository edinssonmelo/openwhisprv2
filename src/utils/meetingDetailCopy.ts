import type { DashboardSessionSummary } from '../types/dashboardSession';

export function getSessionCopyText(session: DashboardSessionSummary): string {
  if (session.dialogueLines?.length) {
    return session.dialogueLines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
  }
  return session.transcriptText?.trim() || session.transcriptPreview?.trim() || '';
}

export function getMeetingSummaryCopyText(session: DashboardSessionSummary): string {
  return (
    session.meetingSummary?.trim() ||
    session.refinedSummaryLine?.trim() ||
    session.refinedText?.trim() ||
    ''
  );
}
