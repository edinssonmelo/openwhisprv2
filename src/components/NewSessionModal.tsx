import { useMemo, useState } from 'react';
import type { ContextSpace, PromptProfile } from '../storage/appPreferences';
import type { DashboardSessionSummary } from '../types/dashboardSession';

export interface NewSessionContext {
  title?: string;
  meetingContext?: string;
  topics: string[];
  relatedSessionIds: string[];
  contextSpaceIds: string[];
  promptProfileId: string;
  language: 'es' | 'en';
}

interface NewSessionModalProps {
  sessions: DashboardSessionSummary[];
  contextSpaces: ContextSpace[];
  promptProfiles: PromptProfile[];
  selectedPromptProfileId: string;
  language: 'es' | 'en';
  onCancel: () => void;
  onConfirm: (context: NewSessionContext) => void;
}

export function NewSessionModal({
  sessions,
  contextSpaces,
  promptProfiles,
  selectedPromptProfileId,
  language,
  onCancel,
  onConfirm,
}: NewSessionModalProps) {
  const [title, setTitle] = useState('');
  const [promptProfileId, setPromptProfileId] = useState(selectedPromptProfileId);
  const [contextSpaceId, setContextSpaceId] = useState(contextSpaces[0]?.id ?? 'general');
  const [sessionLanguage, setSessionLanguage] = useState<'es' | 'en'>(language);

  const activeContextSpace = contextSpaces.find((space) => space.id === contextSpaceId) ?? contextSpaces[0];
  const contextMeetings = useMemo(() => {
    const ids = new Set(activeContextSpace?.sessionIds ?? []);
    return sessions.filter((session) => ids.has(session.id)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
  }, [activeContextSpace?.sessionIds, sessions]);

  const confirm = () => {
    onConfirm({
      title: title.trim() || undefined,
      meetingContext: activeContextSpace?.description,
      topics: [],
      relatedSessionIds: activeContextSpace?.sessionIds ?? [],
      contextSpaceIds: activeContextSpace ? [activeContextSpace.id] : [],
      promptProfileId,
      language: sessionLanguage,
    });
  };

  return (
    <div className="dashboard-shell-modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="dashboard-shell-modal ns-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="new-session-title">New session</h2>
          <button type="button" aria-label="Close" onClick={onCancel}>×</button>
        </header>
        <div className="dashboard-shell-modal-body dashboard-modal-form">

          {/* Prompt / assistant */}
          <div className="ns-section">
            <span className="ns-section-label">Assistant</span>
            <div className="ns-pill-group" role="group" aria-label="Select assistant">
              {promptProfiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={`ns-pill ${profile.id === promptProfileId ? 'ns-pill--active' : ''}`}
                  onClick={() => setPromptProfileId(profile.id)}
                >
                  {profile.name}
                </button>
              ))}
            </div>
          </div>

          {/* Context space */}
          <div className="ns-section">
            <span className="ns-section-label">Context</span>
            <div className="ns-pill-group" role="group" aria-label="Select context">
              {contextSpaces.map((space) => (
                <button
                  key={space.id}
                  type="button"
                  className={`ns-pill ${space.id === contextSpaceId ? 'ns-pill--active' : ''}`}
                  onClick={() => setContextSpaceId(space.id)}
                >
                  {space.name}
                  {space.sessionIds.length > 0 ? (
                    <span className="ns-pill-badge">{space.sessionIds.length}</span>
                  ) : null}
                </button>
              ))}
            </div>
            {contextMeetings.length > 0 ? (
              <div className="ns-context-preview">
                {contextMeetings.map((session) => (
                  <span key={session.id} className="ns-context-meeting">{session.title}</span>
                ))}
              </div>
            ) : activeContextSpace?.description ? (
              <p className="ns-context-desc">{activeContextSpace.description}</p>
            ) : null}
          </div>

          {/* Title + language */}
          <div className="ns-two-col">
            <label className="dashboard-modal-field">
              <span>Title (optional)</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Weekly sync, 1:1, Kickoff..." />
            </label>
            <label className="dashboard-modal-field">
              <span>Language</span>
              <select value={sessionLanguage} onChange={(event) => setSessionLanguage(event.target.value as 'es' | 'en')}>
                <option value="es">Español</option>
                <option value="en">English</option>
              </select>
            </label>
          </div>

          <div className="dashboard-modal-inline-actions">
            <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
            <button type="button" className="dashboard-shadcn-primary" onClick={confirm}>Start session</button>
          </div>
        </div>
      </section>
    </div>
  );
}