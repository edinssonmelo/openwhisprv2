import type {
  DashboardSessionSummary,
  MeetingActionItem,
  MeetingAgentInsight,
  MeetingAgentMemory,
} from '../types/dashboardSession';

const KIND_LIMIT = 5;

const KEYWORDS: Record<MeetingAgentInsight['kind'], RegExp[]> = {
  decision: [
    /\b(decidimos|se decidio|se decidió|acordamos|acuerdo|queda aprobado|aprobamos|consenso)\b/i,
    /\b(decided|we agreed|agreement|approved|consensus)\b/i,
  ],
  action: [
    /\b(hay que|tengo que|tenemos que|debo|deberia|debería|pendiente|proximo paso|próximo paso|seguimiento|follow[- ]?up)\b/i,
    /\b(action item|next step|to do|todo|owner|deadline|due)\b/i,
  ],
  question: [
    /\?$/,
    /\b(pregunta|duda|por definir|queda abierto|pendiente de definir|no esta claro|no está claro)\b/i,
    /\b(question|open issue|open question|to clarify|unclear|tbd)\b/i,
  ],
  risk: [
    /\b(riesgo|bloqueo|bloqueador|problema|dependencia|limitacion|limitación|preocupacion|preocupación)\b/i,
    /\b(risk|blocker|blocked|issue|dependency|constraint|concern)\b/i,
  ],
};

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function splitCandidateLines(text: string): string[] {
  return text
    .split(/[\n.。!?]+/)
    .map(normalizeText)
    .filter((line) => line.length >= 16 && line.length <= 320);
}

function shortTitle(text: string) {
  const cleaned = normalizeText(text).replace(/^[–\-*•\s]+/, '');
  if (cleaned.length <= 86) return cleaned;
  return `${cleaned.slice(0, 83).trim()}...`;
}

function makeInsight(kind: MeetingAgentInsight['kind'], text: string, index: number): MeetingAgentInsight {
  return {
    id: `${kind}-${index}-${Math.abs(hashText(text)).toString(36)}`,
    kind,
    title: shortTitle(text),
    sourceExcerpt: shortTitle(text),
    confidence: 'medium',
  };
}

function hashText(text: string) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function uniqueByTitle(items: MeetingAgentInsight[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.title.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractKind(lines: string[], kind: MeetingAgentInsight['kind']) {
  const matches: MeetingAgentInsight[] = [];
  lines.forEach((line, index) => {
    if (matches.length >= KIND_LIMIT) return;
    if (KEYWORDS[kind].some((pattern) => pattern.test(line))) {
      matches.push(makeInsight(kind, line, index));
    }
  });
  return uniqueByTitle(matches).slice(0, KIND_LIMIT);
}

function toActionItems(insights: MeetingAgentInsight[]): MeetingActionItem[] {
  return insights.map((insight) => ({
    id: insight.id.replace(/^action-/, 'action-item-'),
    text: insight.title,
    status: 'open',
    sourceExcerpt: insight.sourceExcerpt,
    confidence: insight.confidence,
  }));
}

export function buildMeetingAgentMemory(session: DashboardSessionSummary): MeetingAgentMemory {
  if (session.agentMemory) return session.agentMemory;

  const source = [session.meetingSummary, session.nextStepsLine, session.refinedText, session.transcriptText]
    .filter(Boolean)
    .join('\n');
  const lines = splitCandidateLines(source);
  const decisions = session.decisions ?? extractKind(lines, 'decision');
  const actionInsights = extractKind(lines, 'action');
  const actionItems = session.actionItems ?? toActionItems(actionInsights);
  const openQuestions = session.openQuestions ?? extractKind(lines, 'question');
  const risks = session.risks ?? extractKind(lines, 'risk');
  const allInsights = session.agentInsights ?? [...decisions, ...actionInsights, ...openQuestions, ...risks];

  return {
    status: allInsights.length > 0 ? 'ready' : 'needs-review',
    decisions,
    actionItems,
    openQuestions,
    risks,
    insights: allInsights,
    generatedAt: Date.now(),
  };
}
