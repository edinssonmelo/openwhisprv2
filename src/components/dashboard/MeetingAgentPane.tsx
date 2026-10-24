import type { MeetingAgentMemory, MeetingAgentInsight } from '../../types/dashboardSession';

const KIND_LABELS: Record<MeetingAgentInsight['kind'], string> = {
  decision: 'Decisions',
  action: 'Actions',
  question: 'Open questions',
  risk: 'Risks',
};

function ConfidenceDot({ confidence }: { confidence?: MeetingAgentInsight['confidence'] }) {
  return <span className={`meeting-agent__confidence meeting-agent__confidence--${confidence ?? 'medium'}`} aria-hidden />;
}

function InsightList({
  title,
  items,
}: {
  title: string;
  items: Array<{ id: string; title: string; sourceExcerpt?: string; confidence?: MeetingAgentInsight['confidence'] }>;
}) {
  return (
    <section className="meeting-agent__section">
      <div className="meeting-agent__section-head">
        <h3>{title}</h3>
        <span>{items.length}</span>
      </div>
      {items.length > 0 ? (
        <ul className="meeting-agent__list">
          {items.map((item) => (
            <li key={item.id} className="meeting-agent__item">
              <ConfidenceDot confidence={item.confidence} />
              <span className="meeting-agent__item-text">{item.title}</span>
              {item.sourceExcerpt ? <span className="meeting-agent__source">Source: {item.sourceExcerpt}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="meeting-agent__empty-line">Nothing captured yet.</p>
      )}
    </section>
  );
}

export function MeetingAgentPane({ memory }: { memory: MeetingAgentMemory }) {
  const actionInsights = memory.actionItems.map((item) => ({
    id: item.id,
    title: item.text,
    sourceExcerpt: item.sourceExcerpt,
    confidence: item.confidence,
  }));
  const total = memory.decisions.length + memory.actionItems.length + memory.openQuestions.length + memory.risks.length;

  return (
    <div className="meeting-agent" aria-label="Agent memory">
      <div className="meeting-agent__hero">
        <div>
          <p className="meeting-agent__eyebrow">Agent memory</p>
          <h2>{memory.status === 'ready' ? 'Structured meeting state' : 'Ready for agent review'}</h2>
        </div>
        <span className={`meeting-agent__status meeting-agent__status--${memory.status}`}>
          {memory.status === 'ready' ? `${total} signals` : 'No signals'}
        </span>
      </div>

      {memory.status === 'needs-review' ? (
        <p className="meeting-agent__empty">
          The agent has the transcript, but no decisions, actions, questions, or risks were detected yet.
        </p>
      ) : null}

      <div className="meeting-agent__sections">
        <InsightList title={KIND_LABELS.decision} items={memory.decisions} />
        <InsightList title={KIND_LABELS.action} items={actionInsights} />
        <InsightList title={KIND_LABELS.question} items={memory.openQuestions} />
        <InsightList title={KIND_LABELS.risk} items={memory.risks} />
      </div>
    </div>
  );
}
