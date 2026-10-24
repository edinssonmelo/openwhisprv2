import { useState } from 'react';
import type { ContextSpace } from '../storage/appPreferences';
import type { DashboardSessionSummary } from '../types/dashboardSession';

interface ContextSpaceAssignmentModalProps {
  session: DashboardSessionSummary;
  contextSpaces: ContextSpace[];
  onClose: () => void;
  onAssign: (spaceId: string) => void;
  onCreateAndAssign: (name: string) => void;
  onSkip: () => void;
}

export function ContextSpaceAssignmentModal({
  session,
  contextSpaces,
  onClose,
  onAssign,
  onCreateAndAssign,
  onSkip,
}: ContextSpaceAssignmentModalProps) {
  const initialSpaceId = session.contextSpaceIds?.[0] ?? contextSpaces[0]?.id ?? 'general';
  const [spaceId, setSpaceId] = useState(initialSpaceId);
  const [newSpaceName, setNewSpaceName] = useState('');

  const createName = newSpaceName.trim();

  return (
    <div className="dashboard-shell-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="dashboard-shell-modal context-assign-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-assign-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="context-assign-title">Guardar contexto</h2>
          <button type="button" aria-label="Cerrar" onClick={onClose}>×</button>
        </header>
        <div className="dashboard-shell-modal-body dashboard-modal-form">
          <p className="muted">Añade “{session.title}” a un contexto para que futuras sesiones puedan usar esta reunión como referencia.</p>
          <label className="dashboard-modal-field">
            <span>Espacio existente</span>
            <select value={spaceId} onChange={(event) => setSpaceId(event.target.value)}>
              {contextSpaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
            </select>
          </label>
          <label className="dashboard-modal-field">
            <span>O crear nuevo contexto</span>
            <input value={newSpaceName} onChange={(event) => setNewSpaceName(event.target.value)} placeholder="Cliente ACME, Product launch, Hiring..." />
          </label>
          <div className="dashboard-modal-inline-actions">
            <button type="button" className="secondary" onClick={onSkip}>Ahora no</button>
            <button
              type="button"
              className="secondary"
              disabled={!createName}
              onClick={() => onCreateAndAssign(createName)}
            >
              Crear y añadir
            </button>
            <button type="button" className="dashboard-shadcn-primary" onClick={() => onAssign(spaceId)}>Añadir</button>
          </div>
        </div>
      </section>
    </div>
  );
}