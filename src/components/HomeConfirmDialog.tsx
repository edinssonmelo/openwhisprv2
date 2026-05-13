interface HomeConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function HomeConfirmDialog({ open, onConfirm, onCancel }: HomeConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="home-confirm-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="home-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="home-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="home-confirm-title">End session and return to dashboard?</h2>
        <p>Capture will stop. If you have transcript text, a snapshot will be saved.</p>
        <div className="home-confirm-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="dashboard-start-button" onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
