export type AsrPipelineMode = 'baseline-whisper' | 'moonshine-qwen-v2';

export type AsrFinalEngineMode = 'whisper' | 'qwen' | 'compare';

export type AsrModelRole = 'preview' | 'final' | 'fallback-final';

export type AsrEngineName = 'whisper-large-v3-turbo' | 'moonshine' | 'qwen3-asr';

export type TranscriptRefinementMode = 'off' | 'whisper-only' | 'whisper-qwen';

export interface TranscriptPreviewInput {
  segmentId: string;
  text: string;
  engine?: AsrEngineName;
  receivedAtMs?: number;
}

export interface TranscriptFinalInput {
  segmentId: string;
  text: string;
  engine?: AsrEngineName;
  receivedAtMs?: number;
}

export interface TranscriptPreviewHistoryEntry {
  segmentId: string;
  rawPreview: string;
  stablePreview: string;
  acceptedText: string;
  reason: string;
  receivedAtMs: number;
}

export interface TranscriptViewState {
  committedText: string;
  previewSuffix: string;
  rawPreview: string;
  segmentId: string | null;
  visibleText: string;
  lastReason: string;
  previewHistory: TranscriptPreviewHistoryEntry[];
}
