import type { TranscriptRefinementMode } from './types';

export interface RefinementSegmentInput {
  id: string;
  startMs: number;
  endMs: number;
  whisperText: string;
  qwenText?: string;
  source: 'mic' | 'system' | 'mixed';
}

export interface FinalRefinementBatch {
  batchId: string;
  segments: RefinementSegmentInput[];
  mode: Exclude<TranscriptRefinementMode, 'off'>;
  glossary: string;
  context: string;
  language: 'Spanish';
}

export interface FinalTranscriptExport {
  rawWhisperText: string;
  rawQwenText?: string;
  refinedText: string;
  segments: RefinementSegmentInput[];
  enginesUsed: string[];
  refinementModel?: string | null;
  createdAt: string;
}

export function shouldCreateRefinementBatch(args: {
  mode: TranscriptRefinementMode;
  pendingSegmentCount: number;
  pendingDurationMs: number;
  force?: boolean;
}): boolean {
  if (args.mode === 'off') return false;
  if (args.pendingSegmentCount === 0) return false;
  if (args.force) return true;
  return args.pendingSegmentCount >= 6 || args.pendingDurationMs >= 75_000;
}

export function buildFinalTranscriptRefinementPrompt(batch: FinalRefinementBatch): string {
  const segmentLines = batch.segments.map((segment, index) => {
    const qwen = batch.mode === 'whisper-qwen' && segment.qwenText?.trim()
      ? `\nQwen apoyo: ${segment.qwenText.trim()}`
      : '';
    return [
      `Segmento ${index + 1} (${formatMs(segment.startMs)}-${formatMs(segment.endMs)}):`,
      `Whisper principal: ${segment.whisperText.trim()}`,
      qwen,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return [
    'Eres un refinador conservador de transcripciones en español conversacional.',
    '',
    'Reglas obligatorias:',
    '- No inventes información.',
    '- No agregues frases que no estén soportadas por Whisper o Qwen.',
    '- Whisper es la fuente principal.',
    '- Qwen solo sirve como apoyo secundario si Whisper está dudoso.',
    '- Si hay duda entre Whisper y Qwen, preferí Whisper.',
    '- Mejorá puntuación, signos de interrogación, mayúsculas y separación de frases.',
    '- Corregí repeticiones obvias solo si son errores de transcripción.',
    '- Mantené muletillas importantes si cambian el sentido.',
    '- Mantené términos técnicos.',
    '- No resumas.',
    '- No conviertas en acta.',
    '- No cambies el tono del hablante.',
    '- No censures.',
    '- No embellezcas demasiado.',
    '- Devolvé solo el texto refinado, sin prefacios ni listas.',
    '',
    `Glosario: ${batch.glossary || '(sin glosario)'}`,
    '',
    `Contexto previo refinado:\n${batch.context || '(sin contexto previo)'}`,
    '',
    `Segmentos:\n${segmentLines}`,
    '',
    'Texto refinado:',
  ].join('\n');
}

export function createFinalTranscriptExport(args: {
  segments: RefinementSegmentInput[];
  refinedText?: string;
  refinementModel?: string | null;
  createdAt?: string;
}): FinalTranscriptExport {
  const rawWhisperText = args.segments.map((segment) => segment.whisperText).join(' ').replace(/\s+/g, ' ').trim();
  const rawQwenText = args.segments
    .map((segment) => segment.qwenText ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    rawWhisperText,
    ...(rawQwenText ? { rawQwenText } : {}),
    refinedText: (args.refinedText ?? '').trim() || rawWhisperText,
    segments: args.segments,
    enginesUsed: rawQwenText ? ['whisper-large-v3-turbo', 'qwen3-asr'] : ['whisper-large-v3-turbo'],
    refinementModel: args.refinementModel ?? null,
    createdAt: args.createdAt ?? new Date().toISOString(),
  };
}

function formatMs(value: number): string {
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}
