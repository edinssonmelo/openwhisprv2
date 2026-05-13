import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { DashboardSessionSummary } from '../../types/dashboardSession';
import { copyToClipboard } from '../../utils/copyToClipboard';
import { formatDurationMins, formatSessionDateShort } from '../../utils/meetingDetailFormat';
import { useMeetingNotes } from '../../hooks/useMeetingNotes';
import { useViewportMeetingLayout } from '../../hooks/useViewportMeetingLayout';
import { MeetingCompanionPanel } from './MeetingCompanionPanel';
import { MeetingTranscriptPane } from './MeetingTranscriptPane';

export type CompanionMode = 'notes' | 'ai' | null;

const COMPANION_MODE_STORAGE_KEY = 'openwhispr.meetingDetail.companionMode.v1';
const LEGACY_COMPANION_OPEN_KEY = 'openwhispr.meetingDetail.companionOpen.v1';
const COMPANION_DOCK_RECT_STORAGE_KEY = 'openwhispr.meetingDetail.companionDockRect.v5';

type DockRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type StoredDockRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const DOCK_MIN_W = 200;
const DOCK_MIN_H = 150;
const DOCK_MAX_W = 520;
const DOCK_MAX_H = 520;
const DOCK_MARGIN = 14;
const CLOSE_SAFE_TOP = 78;
const CLOSE_SAFE_RIGHT_W = 96;

/** Default dock: narrower than before; height respects effectiveMinDockHeight */
const DOCK_DEFAULT_W = 280;
const DOCK_DEFAULT_H = 224;

function effectiveMinDockHeight(stageHeight: number): number {
  return Math.max(DOCK_MIN_H, Math.ceil(DOCK_MIN_H * 1.05), Math.round(stageHeight * 0.05));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampDockRect(rect: DockRect, stageWidth: number, stageHeight: number): DockRect {
  const minH = effectiveMinDockHeight(stageHeight);
  const maxWidth = Math.max(DOCK_MIN_W, Math.min(DOCK_MAX_W, stageWidth - DOCK_MARGIN * 2));
  const maxHeight = Math.max(minH, Math.min(DOCK_MAX_H, stageHeight - DOCK_MARGIN * 2));

  const width = clampNumber(rect.width, DOCK_MIN_W, maxWidth);
  const height = clampNumber(rect.height, minH, maxHeight);

  let x = clampNumber(rect.x, DOCK_MARGIN, Math.max(DOCK_MARGIN, stageWidth - width - DOCK_MARGIN));
  let y = clampNumber(rect.y, DOCK_MARGIN, Math.max(DOCK_MARGIN, stageHeight - height - DOCK_MARGIN));

  const overlapsCloseZone = x + width > stageWidth - CLOSE_SAFE_RIGHT_W && y < CLOSE_SAFE_TOP;

  if (overlapsCloseZone) {
    y = Math.min(Math.max(CLOSE_SAFE_TOP, y), Math.max(DOCK_MARGIN, stageHeight - height - DOCK_MARGIN));
  }

  return { x, y, width, height };
}

/** Gap between modal right edge and dock; dock top starts just below tools column */
const DOCK_SNAP_GAP_X = 12;
const DOCK_SNAP_GAP_Y = 10;
const TOOLBAR_OFFSET_FROM_SHELL_TOP = 10;
const TOOLBAR_STACK_PX = 110;

function layoutDockRectBesideModal(
  stageW: number,
  stageH: number,
  shellLeft: number,
  shellTop: number,
  shellW: number,
  _shellH: number,
  preferredW: number,
  preferredH: number,
): DockRect {
  const shellRight = shellLeft + shellW;
  const toolbarTop = shellTop + TOOLBAR_OFFSET_FROM_SHELL_TOP;
  const toolbarBottom = toolbarTop + TOOLBAR_STACK_PX;

  const minH = effectiveMinDockHeight(stageH);
  const maxH = Math.min(DOCK_MAX_H, stageH - DOCK_MARGIN * 2);
  const height = clampNumber(preferredH, minH, maxH);

  /* Always to the right of the modal — never pull x left over the card */
  const x = Math.round(shellRight + DOCK_SNAP_GAP_X);
  const maxW = Math.max(DOCK_MIN_W, stageW - DOCK_MARGIN - x);
  const width = clampNumber(preferredW, DOCK_MIN_W, Math.min(DOCK_MAX_W, maxW));

  let y = Math.round(toolbarBottom + DOCK_SNAP_GAP_Y);
  y = clampNumber(y, DOCK_MARGIN, stageH - height - DOCK_MARGIN);

  return clampDockRect({ x, y, width, height }, stageW, stageH);
}

function defaultDockRect(stageWidth: number, stageHeight: number): DockRect {
  const approxShellW = Math.min(580, stageWidth - 80);
  const approxShellH = Math.min(400, Math.max(292, stageHeight * 0.56));
  const shellLeft = (stageWidth - approxShellW) / 2;
  const shellTop = Math.max(0, (stageHeight - approxShellH) / 2);

  return layoutDockRectBesideModal(
    stageWidth,
    stageHeight,
    shellLeft,
    shellTop,
    approxShellW,
    approxShellH,
    DOCK_DEFAULT_W,
    DOCK_DEFAULT_H,
  );
}

function dockRectToStorage(rect: DockRect, stageWidth: number, stageHeight: number): StoredDockRect {
  return {
    x: rect.x / stageWidth,
    y: rect.y / stageHeight,
    width: rect.width / stageWidth,
    height: rect.height / stageHeight,
  };
}

function dockRectFromStorage(stored: StoredDockRect, stageWidth: number, stageHeight: number): DockRect {
  return clampDockRect(
    {
      x: stored.x * stageWidth,
      y: stored.y * stageHeight,
      width: stored.width * stageWidth,
      height: stored.height * stageHeight,
    },
    stageWidth,
    stageHeight,
  );
}

function readStoredDockRect(stageWidth: number, stageHeight: number): DockRect | null {
  try {
    const raw = localStorage.getItem(COMPANION_DOCK_RECT_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredDockRect>;

    if (
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number'
    ) {
      return null;
    }

    return dockRectFromStorage(parsed as StoredDockRect, stageWidth, stageHeight);
  } catch {
    return null;
  }
}

function persistDockRect(rect: DockRect, stageWidth: number, stageHeight: number) {
  try {
    localStorage.setItem(COMPANION_DOCK_RECT_STORAGE_KEY, JSON.stringify(dockRectToStorage(rect, stageWidth, stageHeight)));
  } catch {
    /* ignore */
  }
}

function readCompanionModePref(): CompanionMode {
  try {
    const raw = localStorage.getItem(COMPANION_MODE_STORAGE_KEY);
    if (raw === 'notes' || raw === 'ai') return raw;
    if (raw === 'closed') return null;
    const legacy = localStorage.getItem(LEGACY_COMPANION_OPEN_KEY);
    if (legacy === '1') return 'notes';
  } catch {
    /* ignore */
  }
  return null;
}

function IconClose({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 18L18 6M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconNotesTool({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      {/* Notes.app–style sheet: rounded pad + fold + ruled lines (monochrome) */}
      <path
        d="M8.25 3.25h9.25A2.25 2.25 0 0120 5.5v11.25L15.5 21H8.25A2.25 2.25 0 016 18.75V5.5a2.25 2.25 0 012.25-2.25z"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path
        d="M15.5 21v-3.25a2.25 2.25 0 012.25-2.25H21"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9.25 8.5h6.75M9.25 11.25h6.75M9.25 14h5" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

function IconAiTool({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="m14 7 3 3M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Feather-style rotate-ccw — reads as “reset / restore”. */
function IconResetDockPosition({ className }: { className?: string }) {
  return (
    <svg className={className} width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M1 4v6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconPanelMinimize({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function MeetingDetailModal({
  session,
  onClose,
  onNotify,
}: {
  session: DashboardSessionSummary;
  onClose: () => void;
  onNotify?: (message: string) => void;
}) {
  const layout = useViewportMeetingLayout();
  const detailBackdropDownOnEmptyRef = useRef(false);
  const { text: noteText, setText: setNoteText, saveStatus } = useMeetingNotes(session.id);
  const [companionMode, setCompanionMode] = useState<CompanionMode>(readCompanionModePref);
  const [mobileSection, setMobileSection] = useState<'transcript' | 'notes' | 'ai'>('transcript');
  const [askDraft, setAskDraft] = useState('');
  const [chatThread, setChatThread] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);

  const stageRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const companionDockRef = useRef<HTMLDivElement>(null);
  const sideToolsRef = useRef<HTMLDivElement>(null);
  const dockRectRef = useRef<DockRect>({ x: 0, y: 0, width: 336, height: 320 });
  const [dockRect, setDockRect] = useState<DockRect>({ x: 0, y: 0, width: 336, height: 320 });
  const [dockReady, setDockReady] = useState(false);
  const [dockMoving, setDockMoving] = useState(false);
  const [dockResizing, setDockResizing] = useState(false);
  const dockInteractionRef = useRef<null | {
    type: 'drag' | 'resize';
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startRect: DockRect;
  }>(null);

  dockRectRef.current = dockRect;

  const isWide = layout === 'lg' || layout === 'md';
  const companionOpen = companionMode !== null;
  const companionTab = companionMode ?? 'notes';

  const getStageSize = () => {
    const el = stageRef.current;
    if (el) {
      return {
        width: Math.max(1, el.clientWidth),
        height: Math.max(1, el.clientHeight),
      };
    }
    return {
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
    };
  };

  const commitDockRect = (next: DockRect) => {
    const stage = getStageSize();
    const clamped = clampDockRect(next, stage.width, stage.height);
    setDockRect(clamped);
    persistDockRect(clamped, stage.width, stage.height);
  };

  useEffect(() => {
    setMobileSection('transcript');
    setAskDraft('');
    setChatThread([]);
    setCompanionMode(readCompanionModePref());
  }, [session.id]);

  useEffect(() => {
    try {
      const v = companionMode === null ? 'closed' : companionMode;
      localStorage.setItem(COMPANION_MODE_STORAGE_KEY, v);
    } catch {
      /* ignore */
    }
  }, [companionMode]);

  useLayoutEffect(() => {
    if (!isWide) {
      setDockReady(false);
      return;
    }

    const stageEl = stageRef.current;
    const shellEl = shellRef.current;
    const stage = getStageSize();
    const stored = readStoredDockRect(stage.width, stage.height);

    let initial: DockRect;
    if (stored) {
      initial = stored;
    } else if (stageEl && shellEl) {
      const s = stageEl.getBoundingClientRect();
      const sh = shellEl.getBoundingClientRect();
      const sw = stageEl.clientWidth;
      const shh = stageEl.clientHeight;
      const shellLeft = sh.left - s.left;
      const shellTop = sh.top - s.top;
      initial = layoutDockRectBesideModal(sw, shh, shellLeft, shellTop, sh.width, sh.height, DOCK_DEFAULT_W, DOCK_DEFAULT_H);
    } else {
      initial = defaultDockRect(stage.width, stage.height);
    }

    setDockRect(initial);
    setDockReady(true);
  }, [isWide, session.id]);

  useEffect(() => {
    if (!isWide) return;

    const onResize = () => {
      const stage = getStageSize();
      setDockRect((current) => {
        const clamped = clampDockRect(current, stage.width, stage.height);
        persistDockRect(clamped, stage.width, stage.height);
        return clamped;
      });
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isWide]);

  useEffect(() => {
    const clearBackdropArming = () => {
      detailBackdropDownOnEmptyRef.current = false;
    };
    window.addEventListener('pointerup', clearBackdropArming);
    window.addEventListener('pointercancel', clearBackdropArming);
    return () => {
      window.removeEventListener('pointerup', clearBackdropArming);
      window.removeEventListener('pointercancel', clearBackdropArming);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isWide && companionOpen) {
        e.preventDefault();
        e.stopPropagation();
        setCompanionMode(null);
        return;
      }
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isWide, companionOpen, onClose]);

  const onCompanionTabChange = (t: 'notes' | 'ai') => {
    setCompanionMode(t);
    if (layout === 'sm') {
      setMobileSection(t === 'notes' ? 'notes' : 'ai');
    }
  };

  const onMobileSectionChange = (s: 'transcript' | 'notes' | 'ai') => {
    setMobileSection(s);
    if (s === 'notes') setCompanionMode('notes');
    if (s === 'ai') setCompanionMode('ai');
  };

  const sendAiMessage = (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    setAskDraft('');
    setChatThread((prev) => [...prev, { role: 'user', text: q }]);
    window.setTimeout(() => {
      setChatThread((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: 'Assistant for saved meetings is coming soon.',
        },
      ]);
    }, 320);
  };

  const onAskSend = () => sendAiMessage(askDraft);

  const onCopyNotes = async () => {
    const t = noteText.trim();
    if (!t) {
      onNotify?.('No notes to copy.');
      return;
    }
    const ok = await copyToClipboard(t);
    onNotify?.(ok ? 'Notes copied.' : 'Could not copy.');
  };

  const onCopyMessage = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    const ok = await copyToClipboard(t);
    onNotify?.(ok ? 'Copied.' : 'Could not copy.');
  };

  const companionPanelProps = {
    tab: companionTab,
    onTabChange: onCompanionTabChange,
    notesText: noteText,
    notesSaveStatus: saveStatus,
    onNotesChange: setNoteText,
    onCopyNotes: () => void onCopyNotes(),
    chatThread,
    askDraft,
    onAskDraftChange: setAskDraft,
    onSend: onAskSend,
    onSendMessage: (msg: string) => sendAiMessage(msg),
    onCopyMessage: (msg: string) => void onCopyMessage(msg),
  };

  const showTranscriptSm = layout === 'sm' && mobileSection === 'transcript';
  const showCompanionSm = layout === 'sm' && (mobileSection === 'notes' || mobileSection === 'ai');

  const shellClass = ['meeting-detail-shell', `meeting-detail-shell--layout-${layout}`].join(' ');

  const beginDockDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!isWide) return;

    const target = event.target as HTMLElement;

    if (
      target.closest('button') ||
      target.closest('input') ||
      target.closest('textarea') ||
      target.closest('select') ||
      target.closest('[data-dock-resize-handle="true"]')
    ) {
      return;
    }

    dockInteractionRef.current = {
      type: 'drag',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: { ...dockRectRef.current },
    };

    setDockMoving(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginDockResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (!isWide) return;

    event.preventDefault();
    event.stopPropagation();

    dockInteractionRef.current = {
      type: 'resize',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: { ...dockRectRef.current },
    };

    setDockResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onDockPointerMove = (event: PointerEvent<HTMLDivElement | HTMLButtonElement>) => {
    const interaction = dockInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;

    const stage = getStageSize();
    const dx = event.clientX - interaction.startClientX;
    const dy = event.clientY - interaction.startClientY;

    if (interaction.type === 'drag') {
      setDockRect(
        clampDockRect(
          {
            ...interaction.startRect,
            x: interaction.startRect.x + dx,
            y: interaction.startRect.y + dy,
          },
          stage.width,
          stage.height,
        ),
      );
      return;
    }

    setDockRect(
      clampDockRect(
        {
          ...interaction.startRect,
          width: interaction.startRect.width + dx,
          height: interaction.startRect.height + dy,
        },
        stage.width,
        stage.height,
      ),
    );
  };

  const endDockInteraction = (event: PointerEvent<HTMLDivElement | HTMLButtonElement>) => {
    const interaction = dockInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;

    dockInteractionRef.current = null;
    setDockMoving(false);
    setDockResizing(false);

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    const stage = getStageSize();
    setDockRect((current) => {
      const clamped = clampDockRect(current, stage.width, stage.height);
      persistDockRect(clamped, stage.width, stage.height);
      return clamped;
    });
  };

  const resetDockRect = () => {
    const stageEl = stageRef.current;
    const shellEl = shellRef.current;
    const stage = getStageSize();
    let next: DockRect;
    if (stageEl && shellEl) {
      const s = stageEl.getBoundingClientRect();
      const sh = shellEl.getBoundingClientRect();
      const sw = stageEl.clientWidth;
      const shh = stageEl.clientHeight;
      const shellLeft = sh.left - s.left;
      const shellTop = sh.top - s.top;
      next = layoutDockRectBesideModal(sw, shh, shellLeft, shellTop, sh.width, sh.height, DOCK_DEFAULT_W, DOCK_DEFAULT_H);
    } else {
      next = defaultDockRect(stage.width, stage.height);
    }
    setDockRect(next);
    persistDockRect(next, stage.width, stage.height);
  };

  const clearCompanionContent = () => {
    if (companionTab === 'notes') {
      setNoteText('');
      onNotify?.('Notes cleared.');
      return;
    }
    setChatThread([]);
    setAskDraft('');
    onNotify?.('Chat cleared.');
  };

  const canClearCompanion =
    companionTab === 'notes' ? noteText.trim().length > 0 : chatThread.length > 0 || askDraft.trim().length > 0;

  const isInsideMeetingDetailContent = (target: EventTarget | null) => {
    if (!(target instanceof Node)) return false;
    const shell = shellRef.current;
    const dock = companionDockRef.current;
    const tools = sideToolsRef.current;
    return Boolean(
      (shell && shell.contains(target)) || (dock && dock.contains(target)) || (tools && tools.contains(target)),
    );
  };

  const dockClass = [
    'meeting-detail-companion-dock',
    'meeting-detail-companion-dock--user-placed',
    companionMode === 'notes' ? 'meeting-detail-companion-dock--notes' : '',
    companionMode === 'ai' ? 'meeting-detail-companion-dock--ai' : '',
    dockMoving ? 'is-dragging' : '',
    dockResizing ? 'is-resizing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className="meeting-detail-backdrop"
      role="presentation"
      onPointerDownCapture={(e: PointerEvent<HTMLDivElement>) => {
        detailBackdropDownOnEmptyRef.current = !isInsideMeetingDetailContent(e.target);
      }}
      onPointerUpCapture={(e: PointerEvent<HTMLDivElement>) => {
        if (!detailBackdropDownOnEmptyRef.current) return;
        if (isInsideMeetingDetailContent(e.target)) {
          detailBackdropDownOnEmptyRef.current = false;
          return;
        }
        onClose();
        detailBackdropDownOnEmptyRef.current = false;
      }}
      onPointerCancel={() => {
        detailBackdropDownOnEmptyRef.current = false;
      }}
    >
      <div ref={stageRef} className="meeting-detail-stage" role="presentation">
        <div ref={shellRef} className={shellClass} role="dialog" aria-modal="true" aria-label="Meeting detail">
          <section className="meeting-detail-card">
            <header className="meeting-detail__header">
              <div className="meeting-detail__header-main">
                <h2 className="meeting-detail__title">{session.title}</h2>
                <p className="meeting-detail__meta">
                  <span>{formatSessionDateShort(session.createdAt)}</span>
                  <span className="meeting-detail__meta-sep">·</span>
                  <span>{formatDurationMins(session.durationSeconds)}</span>
                </p>
              </div>
              <button type="button" className="meeting-detail__close" onClick={onClose} aria-label="Close">
                <IconClose />
              </button>
            </header>

            {layout === 'sm' ? (
              <div className="meeting-detail__seg-tabs" role="tablist" aria-label="Meeting content">
                <button
                  type="button"
                  role="tab"
                  className={`meeting-detail__seg-tab ${mobileSection === 'transcript' ? 'is-active' : ''}`}
                  aria-selected={mobileSection === 'transcript'}
                  onClick={() => onMobileSectionChange('transcript')}
                >
                  Transcript
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`meeting-detail__seg-tab ${mobileSection === 'notes' ? 'is-active' : ''}`}
                  aria-selected={mobileSection === 'notes'}
                  onClick={() => onMobileSectionChange('notes')}
                >
                  Notes
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`meeting-detail__seg-tab ${mobileSection === 'ai' ? 'is-active' : ''}`}
                  aria-selected={mobileSection === 'ai'}
                  onClick={() => onMobileSectionChange('ai')}
                >
                  Ask AI
                </button>
              </div>
            ) : null}

            <div className="meeting-detail-card__content">
              {layout === 'sm' ? (
                <>
                  {showTranscriptSm ? (
                    <MeetingTranscriptPane session={session} onNotify={onNotify} className="meeting-detail__main" />
                  ) : null}
                  {showCompanionSm ? (
                    <MeetingCompanionPanel {...companionPanelProps} showTabs />
                  ) : null}
                </>
              ) : (
                <MeetingTranscriptPane session={session} onNotify={onNotify} className="meeting-detail__main" />
              )}
            </div>
          </section>
        </div>

        {isWide && companionOpen && dockReady ? (
          <aside
            ref={companionDockRef}
            id="meeting-companion-panel"
            className={dockClass}
            style={{
              left: dockRect.x,
              top: dockRect.y,
              width: dockRect.width,
              height: dockRect.height,
            }}
            aria-hidden={false}
          >
            <div
              className="meeting-detail-companion-dragbar"
              title="Drag panel"
              onPointerDown={beginDockDrag}
              onPointerMove={onDockPointerMove}
              onPointerUp={endDockInteraction}
              onPointerCancel={endDockInteraction}
            >
              <span>{companionTab === 'notes' ? 'Notes' : 'Ask AI'}</span>
              <div className="meeting-detail-companion-dragbar__actions">
                <button
                  type="button"
                  className="meeting-detail-companion-bar-btn"
                  disabled={!canClearCompanion}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    clearCompanionContent();
                  }}
                  aria-label={companionTab === 'notes' ? 'Clear notes in this panel' : 'Clear chat in this panel'}
                  title={companionTab === 'notes' ? 'Erase notes text (not saved until you type again)' : 'Remove all messages and the draft'}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="meeting-detail-companion-bar-btn meeting-detail-companion-bar-btn--icon meeting-detail-companion-bar-btn--snap"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    resetDockRect();
                  }}
                  aria-label="Reset panel position: dock beside the meeting card again"
                  title="Reset position — snap the panel back beside the card (size and place only; your notes and chat stay as they are)"
                >
                  <IconResetDockPosition />
                </button>
                <button
                  type="button"
                  className="meeting-detail-companion-bar-btn meeting-detail-companion-bar-btn--icon"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCompanionMode(null);
                  }}
                  aria-label={companionTab === 'notes' ? 'Hide notes' : 'Hide assistant'}
                  title={companionTab === 'notes' ? 'Hide notes' : 'Hide assistant'}
                >
                  <IconPanelMinimize />
                </button>
              </div>
            </div>

            <MeetingCompanionPanel {...companionPanelProps} showTabs={false} rootHtmlId={false} className="meeting-detail__companion" />

            <button
              type="button"
              className="meeting-detail-companion-resize"
              data-dock-resize-handle="true"
              aria-label="Resize companion panel"
              title="Resize"
              onPointerDown={beginDockResize}
              onPointerMove={onDockPointerMove}
              onPointerUp={endDockInteraction}
              onPointerCancel={endDockInteraction}
            />
          </aside>
        ) : null}

        {isWide ? (
          <div ref={sideToolsRef} className="meeting-detail-side-tools" role="toolbar" aria-label="Notes and assistant">
            <button
              type="button"
              className={`meeting-detail-tool-button ${companionMode === 'notes' ? 'is-active' : ''}`}
              aria-label={companionMode === 'notes' ? 'Hide notes' : 'Open notes'}
              title="Notes"
              aria-expanded={companionMode === 'notes'}
              aria-controls="meeting-companion-panel"
              onClick={() => setCompanionMode((c) => (c === 'notes' ? null : 'notes'))}
            >
              <IconNotesTool />
            </button>
            <button
              type="button"
              className={`meeting-detail-tool-button ${companionMode === 'ai' ? 'is-active' : ''}`}
              aria-label={companionMode === 'ai' ? 'Hide assistant' : 'Open assistant'}
              title="Ask AI"
              aria-expanded={companionMode === 'ai'}
              aria-controls="meeting-companion-panel"
              onClick={() => setCompanionMode((c) => (c === 'ai' ? null : 'ai'))}
            >
              <IconAiTool />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
