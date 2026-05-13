export interface ControlBarPosition {
  x: number;
  y: number;
}

export type ControlBarKind = 'bar' | 'sessionFrame';

const STORAGE_KEY_BAR = 'openwhispr.floatingBarPosition';
const STORAGE_KEY_SESSION = 'openwhispr.sessionFramePosition';
/** Legacy single key (bar + session frame shared); migrated to bar only on first read. */
const LEGACY_STORAGE_KEY = 'openwhispr.controlBarPosition';

function readStoredRaw(key: string): ControlBarPosition | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const x = Number((parsed as ControlBarPosition).x);
    const y = Number((parsed as ControlBarPosition).y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

/** One-time: move legacy position to floating bar key so session frame gets its own default / storage. */
function migrateLegacyToBarKey(): ControlBarPosition | null {
  const v = readStoredRaw(LEGACY_STORAGE_KEY);
  if (!v) return null;
  try {
    localStorage.setItem(STORAGE_KEY_BAR, JSON.stringify(v));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return v;
}

export function persistControlBarPosition(pos: ControlBarPosition, kind: ControlBarKind = 'bar') {
  const key = kind === 'sessionFrame' ? STORAGE_KEY_SESSION : STORAGE_KEY_BAR;
  try {
    localStorage.setItem(key, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

export function defaultControlBarPosition(barWidth: number, barHeight: number, margin = 10): ControlBarPosition {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  return {
    x: Math.round(Math.max(margin, (vw - barWidth) / 2)),
    y: Math.round(Math.max(margin, Math.min(56, vh * 0.05))),
  };
}

export function clampControlBarPosition(
  pos: ControlBarPosition,
  barWidth: number,
  barHeight: number,
  margin = 10,
): ControlBarPosition {
  if (typeof window === 'undefined') return pos;
  const maxX = Math.max(margin, window.innerWidth - barWidth - margin);
  const maxY = Math.max(margin, window.innerHeight - barHeight - margin);
  return {
    x: Math.min(Math.max(margin, pos.x), maxX),
    y: Math.min(Math.max(margin, pos.y), maxY),
  };
}

const FALLBACK_BAR_W = 640;
const FALLBACK_BAR_H = 52;
/** Initial guess until ResizeObserver runs (matches SessionFloatingFrame sizeRef). */
const FALLBACK_SESSION_FRAME_W = 820;
const FALLBACK_SESSION_FRAME_H = 400;

export const CLAMP_MARGIN_FLOATING_BAR = 16;
export const CLAMP_MARGIN_SESSION_FRAME = 8;

function fallbackSize(kind: ControlBarKind) {
  return kind === 'sessionFrame'
    ? { w: FALLBACK_SESSION_FRAME_W, h: FALLBACK_SESSION_FRAME_H }
    : { w: FALLBACK_BAR_W, h: FALLBACK_BAR_H };
}

export function loadControlBarPosition(kind: ControlBarKind = 'bar'): ControlBarPosition {
  const { w, h } = fallbackSize(kind);
  const margin = kind === 'sessionFrame' ? CLAMP_MARGIN_SESSION_FRAME : CLAMP_MARGIN_FLOATING_BAR;
  let stored: ControlBarPosition | null = null;
  if (typeof window !== 'undefined') {
    if (kind === 'bar') {
      stored = readStoredRaw(STORAGE_KEY_BAR) ?? migrateLegacyToBarKey();
    } else {
      stored = readStoredRaw(STORAGE_KEY_SESSION);
    }
  }
  if (stored) return clampControlBarPosition(stored, w, h, margin);
  return defaultControlBarPosition(w, h, margin);
}
