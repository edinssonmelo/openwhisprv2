import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { copyToClipboard } from '../utils/copyToClipboard';
import { groupDashboardSessionsByDay } from '../utils/dashboardMeetingsGroup';
import { getSessionCopyText, getMeetingSummaryCopyText } from '../utils/meetingDetailCopy';
import { formatDurationMins } from '../utils/meetingDetailFormat';
import type { DashboardSessionSummary } from '../types/dashboardSession';
import { readDashboardTheme, writeDashboardTheme, type DashboardTheme } from '../storage/dashboardTheme';
import { MeetingDetailModal } from './dashboard/MeetingDetailModal';

export type { DashboardSessionSummary } from '../types/dashboardSession';

const MEETINGS_RECENT_VISIBLE = 3;

function rowMenuKeyFor(scope: 'home' | 'library', sessionId: string) {
  return `${scope}:${sessionId}`;
}

interface DashboardHomeProps {
  userName: string;
  sessions: DashboardSessionSummary[];
  onStartSession: () => void;
  onOpenSession: (session: DashboardSessionSummary) => void;
  onDeleteSession?: (sessionId: string) => void;
  onNotify?: (message: string) => void;
  onRerunSetup?: () => void;
  /** Small spinner in the top bar while the last meeting summary is being saved. */
  meetingSummaryBusy?: boolean;
}

function sessionSummaryLine(session: DashboardSessionSummary): string {
  const sum = session.meetingSummary?.trim() || session.refinedSummaryLine?.trim();
  if (sum) return sum.length > 140 ? `${sum.slice(0, 137)}…` : sum;
  const p = session.transcriptPreview?.trim();
  if (p) return p;
  const t = session.transcriptText?.trim();
  if (t) return t.length > 140 ? `${t.slice(0, 137)}…` : t;
  const r = session.refinedText?.trim();
  if (r) return r.length > 140 ? `${r.slice(0, 137)}…` : r;
  return 'No description yet.';
}

function IconSearch({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 21l-5.2-5.2M11 18a7 7 0 100-14 7 7 0 000 14z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconBell({ className }: { className?: string }) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2c0 .5-.2 1-.5 1.4L4 17h5m6 0a3 3 0 11-6 0h6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconMore({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="5" r="1.65" fill="currentColor" />
      <circle cx="12" cy="12" r="1.65" fill="currentColor" />
      <circle cx="12" cy="19" r="1.65" fill="currentColor" />
    </svg>
  );
}

function IconClose({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 18L18 6M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

type ProfileModal = 'prompts' | 'settings' | 'account' | null;

export function DashboardHome({
  userName,
  sessions,
  onStartSession,
  onOpenSession,
  onDeleteSession,
  onNotify,
  onRerunSetup,
  meetingSummaryBusy,
}: DashboardHomeProps) {
  const profileWrapRef = useRef<HTMLDivElement>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [openedSession, setOpenedSession] = useState<DashboardSessionSummary | null>(null);
  const [profileModal, setProfileModal] = useState<ProfileModal>(null);
  const [rowMenuKey, setRowMenuKey] = useState<string | null>(null);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  const libraryBackdropArmRef = useRef(false);
  const [meetingsLibraryOpen, setMeetingsLibraryOpen] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [dashboardTheme, setDashboardTheme] = useState<DashboardTheme>(() => readDashboardTheme());

  const filteredSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((session) => {
      const hay = `${session.title} ${session.transcriptPreview ?? ''} ${session.transcriptText ?? ''} ${session.refinedText ?? ''} ${session.refinedSummaryLine ?? ''} ${session.meetingSummary ?? ''}`.toLowerCase();
      return hay.includes(query);
    });
  }, [sessions, searchQuery]);

  const filteredLibrarySessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
    const q = librarySearch.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((session) => {
      const hay = `${session.title} ${session.transcriptPreview ?? ''} ${session.transcriptText ?? ''} ${session.refinedText ?? ''} ${session.refinedSummaryLine ?? ''} ${session.meetingSummary ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [sessions, librarySearch]);

  const homeSessionsLimited = useMemo(
    () => filteredSessions.slice(0, MEETINGS_RECENT_VISIBLE),
    [filteredSessions],
  );

  const homeDayGroups = useMemo(() => groupDashboardSessionsByDay(homeSessionsLimited), [homeSessionsLimited]);

  const libraryDayGroups = useMemo(() => groupDashboardSessionsByDay(filteredLibrarySessions), [filteredLibrarySessions]);

  const hasMoreMeetings = filteredSessions.length > MEETINGS_RECENT_VISIBLE;

  useLayoutEffect(() => {
    const html = document.documentElement;
    if (dashboardTheme === 'dark') {
      html.setAttribute('data-dashboard-theme', 'dark');
      html.style.colorScheme = 'dark';
    } else {
      html.removeAttribute('data-dashboard-theme');
      html.style.colorScheme = 'light';
    }
  }, [dashboardTheme]);

  useEffect(() => {
    if (!meetingsLibraryOpen) {
      setLibrarySearch('');
      setRowMenuKey((k) => (k?.startsWith('library:') ? null : k));
    }
  }, [meetingsLibraryOpen]);

  useEffect(() => {
    if (!profileOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const t = event.target as HTMLElement;
      if (profileWrapRef.current?.contains(t)) return;
      if (t.closest?.('.dashboard-row-menu')) return;
      if (t.closest?.('.dashboard-meeting-more')) return;
      if (t.closest?.('.dashboard-meeting-menu-anchor')) return;
      setProfileOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [profileOpen]);

  useEffect(() => {
    if (!meetingsLibraryOpen) return;
    const clearLibraryArm = () => {
      libraryBackdropArmRef.current = false;
    };
    window.addEventListener('pointerup', clearLibraryArm);
    window.addEventListener('pointercancel', clearLibraryArm);
    return () => {
      window.removeEventListener('pointerup', clearLibraryArm);
      window.removeEventListener('pointercancel', clearLibraryArm);
    };
  }, [meetingsLibraryOpen]);

  useEffect(() => {
    if (!rowMenuKey) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (!rowMenuRef.current?.contains(event.target as Node)) {
        setRowMenuKey(null);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [rowMenuKey]);

  const openProfileModal = (which: Exclude<ProfileModal, null>) => {
    setProfileOpen(false);
    setProfileModal(which);
  };

  const closeProfileModal = () => setProfileModal(null);

  const confirmDeleteSession = (session: DashboardSessionSummary) => {
    if (!onDeleteSession) return;
    if (!window.confirm('¿Eliminar esta reunión? Esta acción no se puede deshacer.')) return;
    if (openedSession?.id === session.id) setOpenedSession(null);
    onDeleteSession(session.id);
    setRowMenuKey(null);
    onNotify?.('Reunión eliminada.');
  };

  const openMeetingDetail = (session: DashboardSessionSummary) => {
    onOpenSession(session);
    setOpenedSession(session);
    setRowMenuKey(null);
  };

  const copyTranscriptForSession = async (session: DashboardSessionSummary) => {
    const t = getSessionCopyText(session);
    if (!t) {
      onNotify?.('Nothing to copy.');
      return;
    }
    const ok = await copyToClipboard(t);
    onNotify?.(ok ? 'Transcript copied.' : 'Could not copy.');
  };

  const copySummaryForSession = async (session: DashboardSessionSummary) => {
    const s = getMeetingSummaryCopyText(session);
    if (!s) {
      onNotify?.('No summary for this meeting.');
      return;
    }
    const ok = await copyToClipboard(s);
    onNotify?.(ok ? 'Summary copied.' : 'Could not copy.');
  };

  const openMeetingFromLibrary = (session: DashboardSessionSummary) => {
    setMeetingsLibraryOpen(false);
    openMeetingDetail(session);
  };

  const renderMeetingCard = (session: DashboardSessionSummary, fromLibrary: boolean) => {
    const handleOpen = () => (fromLibrary ? openMeetingFromLibrary(session) : openMeetingDetail(session));
    const menuKey = rowMenuKeyFor(fromLibrary ? 'library' : 'home', session.id);
    const menuOpen = rowMenuKey === menuKey;
    return (
      <div
        className={`dashboard-meeting-card-group ${menuOpen ? 'is-menu-open' : ''}`}
        key={fromLibrary ? `lib-${session.id}` : session.id}
      >
        <button type="button" className="dashboard-meeting-card-main" onClick={handleOpen}>
          <div className="dashboard-meeting-card-top">
            <h3 className="dashboard-meeting-card-title">{session.title}</h3>
            <div className="dashboard-meeting-card-datetime" aria-label="Duración">
              <span className="dashboard-meeting-card-duration">{formatDurationMins(session.durationSeconds)}</span>
            </div>
          </div>
          <p className="dashboard-meeting-card-summary">{sessionSummaryLine(session)}</p>
        </button>
        <div
          className={`dashboard-meeting-menu-anchor ${fromLibrary ? 'dashboard-meeting-menu-anchor--library' : ''}`}
          ref={menuOpen ? rowMenuRef : undefined}
        >
          <button
            type="button"
            className="dashboard-meeting-more"
            aria-label={`Actions for ${session.title}`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setProfileOpen(false);
              setRowMenuKey((current) => (current === menuKey ? null : menuKey));
            }}
          >
            <IconMore />
          </button>
          {menuOpen ? (
            <div
              className={`dashboard-row-menu ${fromLibrary ? 'dashboard-row-menu--library' : ''}`}
              role="menu"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button type="button" role="menuitem" onClick={handleOpen}>
                View details
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRowMenuKey(null);
                  void copyTranscriptForSession(session);
                }}
              >
                Copy transcription
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRowMenuKey(null);
                  void copySummaryForSession(session);
                }}
              >
                Copy summary
              </button>
              {onDeleteSession ? (
                <button type="button" role="menuitem" className="is-danger" onClick={() => confirmDeleteSession(session)}>
                  Eliminar
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="dashboard-window-root dashboard-shadcn-root">
      <header className="dashboard-top-nav">
        <h1 className="dashboard-top-nav-brand">Openwhispr</h1>
        <div className="dashboard-top-nav-center">
          <label className="dashboard-shadcn-search dashboard-top-nav-search">
            <IconSearch className="dashboard-shadcn-search-icon" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search meetings"
              type="search"
              autoComplete="off"
            />
          </label>
        </div>
        <div className="dashboard-top-nav-actions">
          {meetingSummaryBusy ? (
            <span
              className="dashboard-top-nav-saving"
              role="status"
              aria-live="polite"
              aria-label="Guardando resumen de la reunión"
              title="Guardando resumen…"
            >
              <span className="dashboard-top-nav-saving-spinner" aria-hidden />
            </span>
          ) : null}
          <button type="button" className="dashboard-top-nav-icon" aria-label="Notifications">
            <IconBell className="dashboard-shadcn-icon" />
          </button>
          <div className="dashboard-shadcn-profile-wrap" ref={profileWrapRef}>
            <button
              type="button"
              className="dashboard-top-nav-avatar"
              onClick={() => setProfileOpen((current) => !current)}
              aria-haspopup="menu"
              aria-expanded={profileOpen}
            >
              {userName.slice(0, 1).toUpperCase()}
            </button>
            {profileOpen ? (
              <div className="dashboard-profile-dropdown" role="menu">
                <div className="profile-dropdown-head">
                  <strong>{userName}</strong>
                  <span>Local workspace</span>
                </div>
                <button type="button" role="menuitem" onClick={() => openProfileModal('prompts')}>
                  Prompts
                </button>
                <button type="button" role="menuitem" onClick={() => openProfileModal('settings')}>
                  Settings
                </button>
                <button type="button" role="menuitem" onClick={() => openProfileModal('account')}>
                  Account
                </button>
                <div className="dashboard-profile-dropdown-divider" aria-hidden />
                <button
                  type="button"
                  role="menuitem"
                  className="dashboard-profile-theme-toggle"
                  aria-pressed={dashboardTheme === 'dark'}
                  aria-label={dashboardTheme === 'dark' ? 'Dark mode: on' : 'Dark mode: off'}
                  onClick={() => {
                    const next: DashboardTheme = dashboardTheme === 'dark' ? 'light' : 'dark';
                    setDashboardTheme(next);
                    writeDashboardTheme(next);
                  }}
                >
                  <span className="dashboard-profile-theme-toggle-label">Dark mode</span>
                  <span className={`dashboard-theme-switch ${dashboardTheme === 'dark' ? 'is-on' : ''}`} aria-hidden />
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="muted"
                  onClick={() => {
                    setProfileOpen(false);
                    onNotify?.('Signed out (local session)');
                  }}
                >
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className="dashboard-main-canvas">
        <div className="dashboard-meetings-vertical-center">
          <section className="dashboard-meetings-section" aria-label="Meetings">
            <div className="dashboard-meetings-start-row">
              <button type="button" className="dashboard-shadcn-primary dashboard-start-session-head" onClick={onStartSession}>
                New session
              </button>
            </div>

            <div className="dashboard-meetings-list">
              {filteredSessions.length === 0 ? (
                <div className="dashboard-meetings-empty">
                  {sessions.length === 0 && !searchQuery.trim()
                    ? 'Aún no hay reuniones. Pulsa «Nueva sesión» para grabar y transcribir.'
                    : 'Ninguna reunión coincide con la búsqueda.'}
                </div>
              ) : (
                homeDayGroups.map((group) => (
                  <div key={group.dayKey} className="dashboard-meetings-day-block">
                    <h3 className="dashboard-meetings-day-heading">{group.label}</h3>
                    {group.sessions.map((session) => renderMeetingCard(session, false))}
                  </div>
                ))
              )}
            </div>
            {hasMoreMeetings ? (
              <div className="dashboard-meetings-footer">
                <button
                  type="button"
                  className="dashboard-meetings-see-all"
                  aria-label="Load more meetings"
                  title="Load more meetings"
                  onClick={() => {
                    setRowMenuKey((k) => (k?.startsWith('home:') ? null : k));
                    setMeetingsLibraryOpen(true);
                  }}
                >
                  Load more
                </button>
              </div>
            ) : null}
          </section>
        </div>
      </main>

      {meetingsLibraryOpen ? (
        <div
          className="dashboard-meetings-library-backdrop"
          role="presentation"
          onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
            if (e.target === e.currentTarget) libraryBackdropArmRef.current = true;
          }}
          onPointerUp={(e: PointerEvent<HTMLDivElement>) => {
            if (e.target === e.currentTarget && libraryBackdropArmRef.current) {
              setMeetingsLibraryOpen(false);
            }
          }}
          onPointerCancel={() => {
            libraryBackdropArmRef.current = false;
          }}
        >
          <section
            className="dashboard-meetings-library-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-meetings-library-title"
            onPointerDownCapture={() => {
              libraryBackdropArmRef.current = false;
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="dashboard-meetings-library-header">
              <h2 id="dashboard-meetings-library-title">All meetings</h2>
              <button
                type="button"
                className="dashboard-meetings-library-close"
                onClick={() => setMeetingsLibraryOpen(false)}
                aria-label="Close"
              >
                <IconClose />
              </button>
            </header>
            <label className="dashboard-shadcn-search dashboard-meetings-library-search">
              <IconSearch className="dashboard-shadcn-search-icon" />
              <input
                value={librarySearch}
                onChange={(e) => setLibrarySearch(e.target.value)}
                placeholder="Search meetings"
                type="search"
                autoComplete="off"
              />
            </label>
            <div className="dashboard-meetings-library-list-scroll">
              <div className="dashboard-meetings-list">
                {filteredLibrarySessions.length === 0 ? (
                  <div className="dashboard-meetings-empty">
                    {sessions.length === 0
                      ? 'Aún no hay reuniones guardadas.'
                      : 'Ninguna reunión coincide con la búsqueda.'}
                  </div>
                ) : (
                  libraryDayGroups.map((group) => (
                    <div key={group.dayKey} className="dashboard-meetings-day-block">
                      <h3 className="dashboard-meetings-day-heading">{group.label}</h3>
                      {group.sessions.map((session) => renderMeetingCard(session, true))}
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {openedSession ? (
        <MeetingDetailModal session={openedSession} onClose={() => setOpenedSession(null)} onNotify={onNotify} />
      ) : null}

      {profileModal ? (
        <div className="dashboard-shell-modal-backdrop" role="presentation" onClick={closeProfileModal}>
          <section
            className="dashboard-shell-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-shell-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h2 id="dashboard-shell-modal-title">
                {profileModal === 'prompts' && 'Prompts'}
                {profileModal === 'settings' && 'Settings'}
                {profileModal === 'account' && 'Account'}
              </h2>
              <button type="button" aria-label="Close" onClick={closeProfileModal}>
                ×
              </button>
            </header>
            <div className="dashboard-shell-modal-body">
              {profileModal === 'settings' ? (
                <>
                  <p className="muted">Workspace preferences and defaults.</p>
                  <button
                    type="button"
                    className="dashboard-start-button dashboard-settings-rerun"
                    onClick={() => {
                      onRerunSetup?.();
                      closeProfileModal();
                    }}
                  >
                    Run setup again
                  </button>
                  <p className="muted small">
                    Re-opens microphone and system audio permission steps. Your meetings are not deleted.
                  </p>
                </>
              ) : (
                <p className="muted">
                  {profileModal === 'prompts' && 'Prompt templates and presets will live here.'}
                  {profileModal === 'account' && 'Local profile details will live here.'}
                </p>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
