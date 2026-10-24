import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  CLAMP_MARGIN_SESSION_FRAME,
  clampControlBarPosition,
  loadControlBarPosition,
  persistControlBarPosition,
  type ControlBarPosition,
} from '../hooks/usePersistedControlBarPosition';

interface SessionFloatingFrameProps {
  /** When collapsed, frame height is minimal (bar only); still use same position. */
  collapsed: boolean;
  /** Transcript column hidden to a chip — participates in bar screen anchoring. */
  transcriptMinimized: boolean;
  children: ReactNode;
}

/** Single draggable unit: positions the whole session composition (bar + panels). */
export function SessionFloatingFrame({ collapsed, transcriptMinimized, children }: SessionFloatingFrameProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ width: 820, height: 400 });
  const positionRef = useRef<ControlBarPosition>(loadControlBarPosition('sessionFrame'));
  const [position, setPosition] = useState<ControlBarPosition>(() => positionRef.current);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Last stable screen X of the embedded control bar root (`[data-session-bar-anchor]`) before layout changes. */
  const barScreenLeftRef = useRef<number | null>(null);
  const prevLayoutSigRef = useRef<string | null>(null);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  const measureColumnsSize = () => {
    const el = columnsRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    sizeRef.current = { width: r.width, height: r.height };
  };

  const measureBarScreenLeft = () => {
    const barAnchor = columnsRef.current?.querySelector('[data-session-bar-anchor="true"]') as HTMLElement | null;
    return barAnchor?.getBoundingClientRect().left ?? null;
  };

  const clampAndPersistPosition = (next: ControlBarPosition, width: number, height: number) => {
    const clamped = clampControlBarPosition(next, width, height, CLAMP_MARGIN_SESSION_FRAME);
    persistControlBarPosition(clamped, 'sessionFrame');
    return clamped;
  };

  const preserveBarAnchorAfterLayoutChange = (previousBarLeft: number | null) => {
    measureColumnsSize();
    const { width, height } = sizeRef.current;
    const nextBarLeft = measureBarScreenLeft();
    if (previousBarLeft === null || nextBarLeft === null) {
      setPosition((p) => {
        const c = clampControlBarPosition(p, width, height, CLAMP_MARGIN_SESSION_FRAME);
        if (c.x !== p.x || c.y !== p.y) persistControlBarPosition(c, 'sessionFrame');
        return c;
      });
      return;
    }

    const delta = previousBarLeft - nextBarLeft;
    setPosition((p) => {
      const next = Math.abs(delta) >= 1 ? { x: p.x + delta, y: p.y } : p;
      const c = clampControlBarPosition(next, width, height, CLAMP_MARGIN_SESSION_FRAME);
      if (c.x !== p.x || c.y !== p.y) persistControlBarPosition(c, 'sessionFrame');
      return c;
    });
    barScreenLeftRef.current = previousBarLeft;
  };

  useLayoutEffect(() => {
    const el = columnsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      measureColumnsSize();
    });
    ro.observe(el);
    measureColumnsSize();
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const layoutSig = `${collapsed}-${transcriptMinimized}`;
    const columns = columnsRef.current;
    if (!columns) return;

    measureColumnsSize();
    const r = columns.getBoundingClientRect();
    const barAnchor = columns.querySelector('[data-session-bar-anchor="true"]') as HTMLElement | null;

    const sigChanged = prevLayoutSigRef.current !== null && prevLayoutSigRef.current !== layoutSig;
    prevLayoutSigRef.current = layoutSig;

    if (barAnchor && sigChanged && barScreenLeftRef.current !== null) {
      const barLeft = barAnchor.getBoundingClientRect().left;
      const delta = barScreenLeftRef.current - barLeft;
      if (Math.abs(delta) >= 1) {
        setPosition((p) => {
          const next = { x: p.x + delta, y: p.y };
          return clampAndPersistPosition(next, r.width, r.height);
        });
      }
    }

    if (barAnchor && !sigChanged) {
      barScreenLeftRef.current = barAnchor.getBoundingClientRect().left;
    }
  }, [collapsed, transcriptMinimized]);

  useEffect(() => {
    const onResize = () => {
      preserveBarAnchorAfterLayoutChange(measureBarScreenLeft() ?? barScreenLeftRef.current);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onFramePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('textarea') || target.closest('select')) {
      return;
    }
    // Only start drag from session chrome headers / gutters, not from transcript bodies
    if (!target.closest('[data-session-drag-region="true"]')) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origX: positionRef.current.x,
      origY: positionRef.current.y,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onFramePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || event.pointerId !== d.pointerId) return;
    const { width, height } = sizeRef.current;
    const nx = d.origX + (event.clientX - d.startX);
    const ny = d.origY + (event.clientY - d.startY);
    const c = clampControlBarPosition({ x: nx, y: ny }, width, height, CLAMP_MARGIN_SESSION_FRAME);
    positionRef.current = c;
    setPosition(c);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || event.pointerId !== d.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* noop */
    }
    const { width, height } = sizeRef.current;
    setPosition((prev) => {
      const c = clampControlBarPosition(prev, width, height, CLAMP_MARGIN_SESSION_FRAME);
      persistControlBarPosition(c, 'sessionFrame');
      return c;
    });
    const barAnchor = columnsRef.current?.querySelector('[data-session-bar-anchor="true"]') as HTMLElement | null;
    if (barAnchor) {
      barScreenLeftRef.current = barAnchor.getBoundingClientRect().left;
    }
  };

  return (
    <div
      ref={frameRef}
      className={`session-floating-frame ${collapsed ? 'session-floating-frame--collapsed' : ''} ${dragging ? 'session-floating-frame--dragging' : ''}`}
      style={{ left: position.x, top: position.y }}
    >
      <div
        ref={columnsRef}
        className="session-frame-columns"
        onPointerDown={onFramePointerDown}
        onPointerMove={onFramePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {children}
      </div>
    </div>
  );
}
