import { useEffect } from 'react';

export function PremiumToast({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!message) return undefined;
    const id = window.setTimeout(onDismiss, 2600);
    return () => window.clearTimeout(id);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div className="premium-toast" role="status" aria-live="polite">
      {message}
    </div>
  );
}
