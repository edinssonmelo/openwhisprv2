function heuristicSummary(transcript: string, refined: string): string {
  const src = refined.trim() || transcript.trim();
  if (!src) return '';
  const line = src.split('\n').map((l) => l.trim()).find(Boolean) ?? src;
  const one = line.replace(/\s+/g, ' ').trim();
  return one.length > 600 ? `${one.slice(0, 597)}…` : one;
}

type PolishFn = (payload: {
  batchId: string;
  rawSegments: Array<{
    id: string;
    startMs: number;
    endMs: number;
    text: string;
    source: 'mic' | 'system' | 'mixed';
    rms: number;
  }>;
  context: string;
  glossary: string;
  prompt?: string;
  numPredict?: number;
}) => Promise<{ ok: boolean; text?: string; error?: string }>;

const MEETING_SUMMARY_MAX_OUT_CHARS = 8000;

/**
 * Full meeting summary for the detail view. Uses local polisher when available;
 * otherwise falls back to a short extract from refined/transcript.
 */
export async function generateMeetingSummaryLine(args: {
  transcript: string;
  refined: string;
  glossary: string;
  polisherOk: boolean;
  polishSegment: PolishFn;
}): Promise<string> {
  const base = (args.refined || args.transcript).trim();
  if (!base) return '';
  const fallback = heuristicSummary(args.transcript, args.refined);
  if (!args.polisherOk || base.length < 60) return fallback;

  const excerpt = base.length > 18000 ? `${base.slice(0, 18000)}\n…` : base;
  const prompt = [
    'Eres un asistente ejecutivo.',
    'Leé la transcripción de una reunión (puede tener errores de dictado).',
    'Escribí un resumen en español, completo y coherente:',
    '- Entre 2 y 6 párrafos cortos, o el equivalente en varias oraciones bien cerradas.',
    '- Cubrí los temas principales, el propósito de la reunión y conclusiones o acuerdos si aparecen en el texto.',
    '- No inventes hechos que no estén en la transcripción.',
    '- No uses viñetas, numeración ni saludo.',
    '- No cortes a mitad de frase: terminá cada idea.',
    '',
    'Transcripción:',
    excerpt,
    '',
    'Resumen:',
  ].join('\n');

  try {
    const result = await args.polishSegment({
      batchId: `meeting-summary-${Date.now()}`,
      rawSegments: [
        {
          id: 'meeting-full',
          startMs: 0,
          endMs: 1,
          text: excerpt,
          source: 'mixed',
          rms: 0.1,
        },
      ],
      context: '',
      glossary: args.glossary || '(sin glosario)',
      prompt,
      numPredict: 2048,
    });
    const t = result.ok ? (result.text ?? '').trim() : '';
    if (t.length < 24) return fallback;
    return t.length > MEETING_SUMMARY_MAX_OUT_CHARS ? `${t.slice(0, MEETING_SUMMARY_MAX_OUT_CHARS - 1)}…` : t;
  } catch {
    return fallback;
  }
}

// ── Meeting title generation ─────────────────────────────────────────────────

function heuristicTitle(transcript: string, refined: string): string {
  const src = refined.trim() || transcript.trim();
  if (!src || src.length < 10) return '';
  const firstLine = src
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 15);
  if (!firstLine) return '';
  const cleaned = firstLine.replace(/^[–\-*>\s]+/, '').trim();
  return cleaned.length > 52 ? `${cleaned.slice(0, 50)}…` : cleaned;
}

/**
 * Generates a short, descriptive meeting title (≤ 7 words).
 * Uses the local polisher when available; heuristic fallback otherwise.
 */
export async function generateMeetingTitle(args: {
  transcript: string;
  refined: string;
  summary?: string;
  polisherOk: boolean;
  polishSegment: PolishFn;
}): Promise<string> {
  const base = (args.summary || args.refined || args.transcript).trim();
  const fallback = heuristicTitle(args.transcript, args.refined);
  if (!base || !args.polisherOk || base.length < 40) return fallback;

  const excerpt = base.slice(0, 2400);
  const prompt = [
    'Dado el siguiente fragmento de una reunión de trabajo, generá UN TÍTULO corto y descriptivo.',
    'Reglas estrictas:',
    '- Máximo 7 palabras.',
    '- Sin comillas, sin punto al final, sin numeración, sin prefijos como "Título:".',
    '- Capturá el tema principal o la decisión clave.',
    '- Solo devolvé el título, sin ningún otro texto.',
    '',
    'Fragmento:',
    excerpt,
    '',
    'Título:',
  ].join('\n');

  try {
    const result = await args.polishSegment({
      batchId: `meeting-title-${Date.now()}`,
      rawSegments: [{ id: 'title-gen', startMs: 0, endMs: 1, text: excerpt, source: 'mixed', rms: 0.1 }],
      context: '',
      glossary: '',
      prompt,
      numPredict: 48,
    });
    const raw = (result.ok ? (result.text ?? '') : '').trim();
    // Strip wrapping quotes, trailing dots, "Título:" prefix if model echoed it
    const cleaned = raw
      .replace(/^Título:\s*/i, '')
      .replace(/^["""'']+|["""'']+$/g, '')
      .replace(/\.+$/, '')
      .trim();
    if (cleaned.length < 3 || cleaned.length > 80) return fallback;
    return cleaned;
  } catch {
    return fallback;
  }
}
