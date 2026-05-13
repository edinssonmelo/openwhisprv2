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
  children: ReactNode;
}

/** Single draggable unit: positions the whole session composition (bar + panels). */
export function SessionFloatingFrame({ collapsed, children }: SessionFloatingFrameProps) {
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

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  const remeasureAndClamp = () => {
    const el = columnsRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    sizeRef.current = { width: r.width, height: r.height };
    setPosition((prev) => {
      const c = clampControlBarPosition(prev, r.width, r.height, CLAMP_MARGIN_SESSION_FRAME);
      if (c.x !== prev.x || c.y !== prev.y) persistControlBarPosition(c, 'sessionFrame');
      return c;
    });
  };

  useLayoutEffect(() => {
    const el = columnsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => remeasureAndClamp());
    ro.observe(el);
    remeasureAndClamp();
    return () => ro.disconnect();
  }, [collapsed]);

  useEffect(() => {
    const onResize = () => remeasureAndClamp();
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
