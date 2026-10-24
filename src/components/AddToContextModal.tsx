import { useState } from 'react';
import type { ContextSpace } from '../storage/appPreferences';
import type { DashboardSessionSummary } from '../types/dashboardSession';

interface AddToContextModalProps {
  session: DashboardSessionSummary;
  contextSpaces: ContextSpace[];
  onClose: () => void;
  onSave: (spaceIds: string[]) => void;
}

export function AddToContextModal({ session, contextSpaces, onClose, onSave }: AddToContextModalProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(session.contextSpaceIds ?? []),
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="dashboard-shell-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="dashboard-shell-modal atc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="atc-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="atc-title">Añadir a contexto</h2>
          <button type="button" aria-label="Cerrar" onClick={onClose}>×</button>
        </header>
        <div className="dashboard-shell-modal-body dashboard-modal-form">
          <p className="muted">Seleccioná los espacios donde quieras incluir <strong>"{session.title}"</strong>.</p>
          <div className="atc-space-list">
            {contextSpaces.map((space) => {
              const checked = selected.has(space.id);
              return (
                <label key={space.id} className={`atc-space-row ${checked ? 'atc-space-row--checked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(space.id)}
                    className="atc-checkbox"
                  />
                  <span className="atc-space-name">{space.name}</span>
                  {space.description ? (
                    <span className="atc-space-desc">{space.description}</span>
                  ) : null}
                  <span className="atc-space-count">{space.sessionIds.length} reuniones</span>
                </label>
              );
            })}
          </div>
          <div className="dashboard-modal-inline-actions">
            <button type="button" className="secondary" onClick={onClose}>Cancelar</button>
            <button type="button" className="dashboard-shadcn-primary" onClick={() => onSave([...selected])}>
              Guardar
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
