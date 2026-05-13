import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CLAMP_MARGIN_FLOATING_BAR,
  clampControlBarPosition,
  loadControlBarPosition,
  persistControlBarPosition,
} from '../hooks/usePersistedControlBarPosition';
import type { CapturePreference } from '../storage/appPreferences';

const WAVE_COLORS = ['#8B5CF6', '#A855F7', '#c084fc', '#4BFBBA'] as const;

export type TopControlBarVariant = 'floating' | 'embedded';

interface TopControlBarProps {
  variant?: TopControlBarVariant;
  statusTone: 'idle' | 'recording' | 'processing' | 'interrupted' | 'recovering';
  timerLabel: string;
  askShortcutLabel: string;
  hideShortcutLabel: string;
  isCapturing: boolean;
  isCollapsed: boolean;
  aiPanelOpen: boolean;
  reconnectAudioVisible?: boolean;
  onToggleCapture: () => void;
  onToggleAiPanel: () => void;
  onToggleCollapse: () => void;
  onHome: () => void;
  onOpenAllSettings: () => void;
  onOpenAudioSettings: () => void;
  onEndSession: () => void;
  capturePreference: CapturePreference;
  onCapturePreferenceChange: (mode: CapturePreference) => void;
  onReconnectAudio?: () => void;
}

export function TopControlBar({
  variant = 'floating',
  statusTone,
  timerLabel,
  askShortcutLabel,
  hideShortcutLabel,
  isCapturing,
  isCollapsed,
  aiPanelOpen,
  reconnectAudioVisible = false,
  onToggleCapture,
  onToggleAiPanel,
  onToggleCollapse,
  onHome,
  onOpenAllSettings,
  onOpenAudioSettings,
  onEndSession,
  capturePreference,
  onCapturePreferenceChange,
  onReconnectAudio,
}: TopControlBarProps) {
  const embedded = variant === 'embedded';
  const waveformActive = isCapturing && statusTone !== 'processing';
  const bars = useMemo(
    () =>
      Array.from({ length: 28 }, (_, i) => ({
        h: 4 + ((i * 13) % 13),
        delay: (i * 37) % 1000,
        c: WAVE_COLORS[i % WAVE_COLORS.length],
      })),
    [],
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const barSizeRef = useRef({ width: 640, height: 52 });
  const positionRef = useRef(loadControlBarPosition('bar'));
  const [position, setPosition] = useState(() => positionRef.current);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
  }, [menuOpen]);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  const remeasureAndClamp = () => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    barSizeRef.current = { width: r.width, height: r.height };
    setPosition((prev) => {
      const c = clampControlBarPosition(prev, r.width, r.height, CLAMP_MARGIN_FLOATING_BAR);
      if (c.x !== prev.x || c.y !== prev.y) persistControlBarPosition(c, 'bar');
      return c;
    });
  };

  useLayoutEffect(() => {
    if (embedded) return;
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => remeasureAndClamp());
    ro.observe(el);
    remeasureAndClamp();
    return () => ro.disconnect();
  }, [embedded]);

  useEffect(() => {
    if (embedded) return;
    const onResize = () => remeasureAndClamp();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [embedded]);

  const onBarPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (embedded) return;
    if ((event.target as HTMLElement).closest('button')) return;
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

  const onBarPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (embedded) return;
    const d = dragRef.current;
    if (!d || event.pointerId !== d.pointerId) return;
    const { width, height } = barSizeRef.current;
    const nx = d.origX + (event.clientX - d.startX);
    const ny = d.origY + (event.clientY - d.startY);
    const c = clampControlBarPosition({ x: nx, y: ny }, width, height, CLAMP_MARGIN_FLOATING_BAR);
    positionRef.current = c;
    setPosition(c);
  };

  const endBarDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (embedded) return;
    const d = dragRef.current;
    if (!d || event.pointerId !== d.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    const { width, height } = barSizeRef.current;
    setPosition((prev) => {
      const c = clampControlBarPosition(prev, width, height, CLAMP_MARGIN_FLOATING_BAR);
      persistControlBarPosition(c, 'bar');
      return c;
    });
  };

  const rootStyle = embedded ? undefined : { left: position.x, top: position.y };

  return (
    <div
      ref={rootRef}
      className={`top-control-bar-float-root ${embedded ? 'top-control-bar-float-root--embedded' : ''}`}
      style={rootStyle}
    >
      <header
        data-session-drag-region={embedded ? 'true' : undefined}
        className={`glass-bar top-control-bar-compact ${dragging ? 'top-control-bar-compact--dragging' : ''}`}
        onPointerDown={embedded ? undefined : onBarPointerDown}
        onPointerMove={embedded ? undefined : onBarPointerMove}
        onPointerUp={embedded ? undefined : endBarDrag}
        onPointerCancel={embedded ? undefined : endBarDrag}
      >
        <div className="control-bar-left">
          <button
            type="button"
            className={`glass-pause-toggle ${isCapturing ? 'is-live' : ''}`}
            onClick={onToggleCapture}
            aria-label={isCapturing ? 'Pausar grabación' : 'Iniciar grabación'}
          >
            {isCapturing ? (
              <>
                <span className="pause-bar" />
                <span className="pause-bar" />
              </>
            ) : (
              <span className="play-triangle" />
            )}
          </button>

          {isCapturing ? (
            <div className="waveform-mini" aria-hidden>
              {bars.map((bar, i) => (
                <span
                  key={i}
                  className={`waveform-mini-bar ${waveformActive ? 'waveform-mini-bar--anim' : ''}`}
                  style={{
                    height: `${bar.h}px`,
                    background: bar.c,
                    animationDelay: waveformActive ? `${bar.delay}ms` : undefined,
                  }}
                />
              ))}
            </div>
          ) : null}

          <span className="control-bar-timer">{timerLabel}</span>
        </div>

        <div className="control-bar-drag-spacer" aria-hidden />

        <div className="control-bar-right">
          {reconnectAudioVisible && (
            <button type="button" className="glass-button glass-button-tight warning" onClick={onReconnectAudio}>
              Reconectar
            </button>
          )}

          <button type="button" className="glass-button glass-button-tight" onClick={onToggleAiPanel}>
            {aiPanelOpen ? 'Hide AI' : 'Ask AI'} <kbd>{askShortcutLabel}</kbd>
          </button>

          <button type="button" className="glass-button glass-button-tight" onClick={onToggleCollapse}>
            {isCollapsed ? 'Expand' : 'Minimize'} <kbd>{hideShortcutLabel}</kbd>
          </button>

          <button
            type="button"
            className="glass-button-icon glass-home-button"
            onClick={onHome}
            aria-label="Home / Dashboard"
            title="Dashboard"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V9.5z" strokeLinejoin="round" />
            </svg>
          </button>

          <div className="top-control-menu-wrap" ref={menuRef}>
            <button
              type="button"
              className={`glass-menu-dots ${menuOpen ? 'glass-menu-dots--open' : ''}`}
              aria-label="Menu"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span />
              <span />
              <span />
            </button>
            {menuOpen ? (
              <div className="top-control-menu-dropdown" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onHome();
                  }}
                >
                  Home / Dashboard
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenAudioSettings();
                  }}
                >
                  Audio settings
                </button>
                <div className="top-control-menu-caption" aria-hidden>
                  Transcription capture
                </div>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={capturePreference === 'mic'}
                  onClick={() => {
                    setMenuOpen(false);
                    onCapturePreferenceChange('mic');
                  }}
                >
                  {capturePreference === 'mic' ? '✓ ' : ''}
                  Microphone only
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={capturePreference === 'system'}
                  onClick={() => {
                    setMenuOpen(false);
                    onCapturePreferenceChange('system');
                  }}
                >
                  {capturePreference === 'system' ? '✓ ' : ''}
                  System audio only
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={capturePreference === 'both'}
                  onClick={() => {
                    setMenuOpen(false);
                    onCapturePreferenceChange('both');
                  }}
                >
                  {capturePreference === 'both' ? '✓ ' : ''}
                  Microphone + system audio
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="top-control-menu-muted"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenAllSettings();
                  }}
                >
                  All settings
                </button>
                <hr className="top-control-menu-sep" />
                <button
                  type="button"
                  role="menuitem"
                  className="top-control-menu-danger"
                  onClick={() => {
                    setMenuOpen(false);
                    onEndSession();
                  }}
                >
                  End session
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
    </div>
  );
}
