import { useEffect, useRef } from 'react';

function overlayHitIsInteractive(clientX: number, clientY: number, settingsOpen: boolean): boolean {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return false;
  if (settingsOpen && el.closest('.settings-overlay')) return true;
  if (el.closest('.home-confirm-backdrop')) return true;
  if (el.closest('[data-session-drag-region="true"]')) return true;
  if (el.closest('.top-control-menu-dropdown')) return true;
  const inFrame = el.closest('.session-floating-frame');
  if (inFrame) {
    const control = el.closest(
      '.session-floating-frame button, .session-floating-frame input, .session-floating-frame textarea, .session-floating-frame select, .session-floating-frame [role="button"]',
    );
    if (control && inFrame.contains(control)) return true;
  }
  return Boolean(
    el.closest('.glass-panel-float') ||
      el.closest('.top-control-bar-compact') ||
      el.closest('.top-control-bar-float-root'),
  );
}

/** En modo overlay Electron: pasar clics al OS fuera de los paneles glass (setIgnoreMouseEvents). */
export function useOverlayPointerPassthrough(settingsOpen: boolean, layoutEpoch: string) {
  const lastPos = useRef({ x: typeof window !== 'undefined' ? window.innerWidth / 2 : 0, y: 0 });
  const rafId = useRef(0);
  const flushPending = useRef(false);
  const lastSentIgnore = useRef<boolean | null>(null);

  useEffect(() => {
    if (!window.meetingAssistant.overlayWindow) return;

    const send = (ignore: boolean) => {
      if (lastSentIgnore.current === ignore) return;
      lastSentIgnore.current = ignore;
      window.meetingAssistant.overlay.setPointerPassthrough(ignore);
    };

    const apply = () => {
      flushPending.current = false;
      const { x, y } = lastPos.current;
      const interactive = overlayHitIsInteractive(x, y, settingsOpen);
      send(!interactive);
    };

    const onMove = (event: PointerEvent) => {
      lastPos.current = { x: event.clientX, y: event.clientY };
      if (!flushPending.current) {
        flushPending.current = true;
        rafId.current = requestAnimationFrame(apply);
      }
    };

    document.addEventListener('pointermove', onMove, { passive: true });
    lastSentIgnore.current = null;
    apply();

    return () => {
      document.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(rafId.current);
    };
  }, [settingsOpen, layoutEpoch]);
}
