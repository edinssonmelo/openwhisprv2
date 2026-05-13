export interface DashboardSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  durationSeconds: number;
  transcriptPreview: string;
  transcriptText: string;
  refinedText?: string;
  source: string;
  status: 'completed' | 'draft';
  /** Structured lines for rich meeting detail modal (optional). */
  dialogueLines?: Array<{ speaker: string; text: string }>;
  refinedSummaryLine?: string;
  nextStepsLine?: string;
  showTranscribedBadge?: boolean;
  accentTag?: string;
}
