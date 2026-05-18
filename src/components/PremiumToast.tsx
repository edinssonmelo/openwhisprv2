import { useEffect, useRef } from 'react';

export function PremiumToast({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!message) return undefined;
    const id = window.setTimeout(() => onDismissRef.current(), 2600);
    return () => window.clearTimeout(id);
  }, [message]);

  if (!message) return null;

  return (
    <div className="premium-toast" role="status" aria-live="polite">
      {message}
    </div>
  );
}
