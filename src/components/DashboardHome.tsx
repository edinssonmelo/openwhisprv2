import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { copyToClipboard } from '../utils/copyToClipboard';
import { groupDashboardSessionsByDay } from '../utils/dashboardMeetingsGroup';
import { getSessionCopyText, getMeetingSummaryCopyText } from '../utils/meetingDetailCopy';
import { formatDurationMins } from '../utils/meetingDetailFormat';
import type { DashboardSessionSummary } from '../types/dashboardSession';
import { readDashboardTheme, writeDashboardTheme, type DashboardTheme } from '../storage/dashboardTheme';
import {
  DEFAULT_PROMPT_PROFILE,
  type AppLanguage,
  type CapturePreference,
  type ContextSpace,
  type PromptProfile,
  type SystemCaptureStrategy,
  type UserProfile,
} from '../storage/appPreferences';
import { MeetingDetailModal } from './dashboard/MeetingDetailModal';
import { AddToContextModal } from './AddToContextModal';

export type { DashboardSessionSummary } from '../types/dashboardSession';

const MEETINGS_RECENT_VISIBLE = 3;

function rowMenuKeyFor(scope: 'home' | 'library', sessionId: string) {
  return `${scope}:${sessionId}`;
}

interface DashboardHomeProps {
  userName: string;
  userProfile: UserProfile;
  sessions: DashboardSessionSummary[];
  onStartSession: () => void;
  onOpenSession: (session: DashboardSessionSummary) => void;
  onDeleteSession?: (sessionId: string) => void;
  onNotify?: (message: string) => void;
  onRerunSetup?: () => void;
  capturePreference: CapturePreference;
  onCapturePreferenceChange: (mode: CapturePreference) => void;
  systemCaptureStrategy: SystemCaptureStrategy;
  onSystemCaptureStrategyChange: (strategy: SystemCaptureStrategy) => void;
  appLanguage: AppLanguage;
  onAppLanguageChange: (language: AppLanguage) => void;
  promptProfiles: PromptProfile[];
  contextSpaces: ContextSpace[];
  selectedPromptProfileId: string;
  onPromptProfilesChange: (profiles: PromptProfile[]) => void;
  onContextSpacesChange: (spaces: ContextSpace[]) => void;
  onSelectedPromptProfileIdChange: (id: string) => void;
  onUserProfileChange: (profile: UserProfile) => void;
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

type ProfileModal = 'prompts' | 'contexts' | 'settings' | 'account' | null;

export function DashboardHome({
  userName,
  userProfile,
  sessions,
  onStartSession,
  onOpenSession,
  onDeleteSession,
  onNotify,
  onRerunSetup,
  capturePreference,
  onCapturePreferenceChange,
  systemCaptureStrategy,
  onSystemCaptureStrategyChange,
  appLanguage,
  onAppLanguageChange,
  promptProfiles,
  contextSpaces,
  selectedPromptProfileId,
  onPromptProfilesChange,
  onContextSpacesChange,
  onSelectedPromptProfileIdChange,
  onUserProfileChange,
  meetingSummaryBusy,
}: DashboardHomeProps) {
  const profileWrapRef = useRef<HTMLDivElement>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [openedSession, setOpenedSession] = useState<DashboardSessionSummary | null>(null);
  const [profileModal, setProfileModal] = useState<ProfileModal>(null);
  const [rowMenuKey, setRowMenuKey] = useState<string | null>(null);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  const [contextPickerSession, setContextPickerSession] = useState<DashboardSessionSummary | null>(null);
  const [localToast, setLocalToast] = useState<string | null>(null);
  const localToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showLocalToast = (msg: string) => {
    if (localToastTimerRef.current) clearTimeout(localToastTimerRef.current);
    setLocalToast(msg);
    localToastTimerRef.current = setTimeout(() => setLocalToast(null), 2600);
  };
  const libraryBackdropArmRef = useRef(false);
  const [meetingsLibraryOpen, setMeetingsLibraryOpen] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [dashboardTheme, setDashboardTheme] = useState<DashboardTheme>(() => readDashboardTheme());
  const [accountDraft, setAccountDraft] = useState<UserProfile>(userProfile);
  const [promptDrafts, setPromptDrafts] = useState<PromptProfile[]>(promptProfiles);
  const [contextDrafts, setContextDrafts] = useState<ContextSpace[]>(contextSpaces);
  const [selectedContextDraftId, setSelectedContextDraftId] = useState(contextSpaces[0]?.id ?? 'general');
  const selectedPromptDraft = promptDrafts.find((profile) => profile.id === selectedPromptProfileId) ?? promptDrafts[0] ?? DEFAULT_PROMPT_PROFILE;
  const selectedContextDraft = contextDrafts.find((space) => space.id === selectedContextDraftId) ?? contextDrafts[0];

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

  useEffect(() => {
    if (profileModal === 'account') setAccountDraft(userProfile);
    if (profileModal === 'prompts') setPromptDrafts(promptProfiles);
    if (profileModal === 'contexts') {
      setContextDrafts(contextSpaces);
      setSelectedContextDraftId(contextSpaces[0]?.id ?? 'general');
    }
  }, [contextSpaces, profileModal, promptProfiles, userProfile]);

  const saveAccount = () => {
    const next = { ...accountDraft, name: accountDraft.name.trim() || userName, updatedAt: Date.now() };
    onUserProfileChange(next);
    onNotify?.('Perfil local guardado.');
    closeProfileModal();
  };

  const updatePromptDraft = (patch: Partial<PromptProfile>) => {
    setPromptDrafts((current) => current.map((profile) => (
      profile.id === selectedPromptDraft.id ? { ...profile, ...patch, updatedAt: Date.now() } : profile
    )));
  };

  const addPromptProfile = () => {
    const id = `prompt-${Date.now()}`;
    const next: PromptProfile = {
      ...DEFAULT_PROMPT_PROFILE,
      id,
      name: 'Custom assistant',
      isDefault: false,
      updatedAt: Date.now(),
    };
    setPromptDrafts((current) => [...current, next]);
    onSelectedPromptProfileIdChange(id);
  };

  const savePrompts = () => {
    const normalized = promptDrafts.map((profile) => ({
      ...profile,
      name: profile.name.trim() || 'Untitled prompt',
      systemPrompt: profile.systemPrompt.trim() || DEFAULT_PROMPT_PROFILE.systemPrompt,
      contextPrompt: profile.contextPrompt.trim() || DEFAULT_PROMPT_PROFILE.contextPrompt,
      updatedAt: Date.now(),
    }));
    onPromptProfilesChange(normalized);
    if (!normalized.some((profile) => profile.id === selectedPromptProfileId)) {
      onSelectedPromptProfileIdChange(normalized[0]?.id ?? DEFAULT_PROMPT_PROFILE.id);
    }
    onNotify?.('Prompts guardados localmente.');
    closeProfileModal();
  };

  const addContextSpace = () => {
    const id = `context-${Date.now()}`;
    const next: ContextSpace = {
      id,
      name: 'Nuevo contexto',
      description: '',
      sessionIds: [],
      updatedAt: Date.now(),
    };
    setContextDrafts((current) => [...current, next]);
    setSelectedContextDraftId(id);
  };

  const updateContextDraft = (patch: Partial<ContextSpace>) => {
    if (!selectedContextDraft) return;
    setContextDrafts((current) => current.map((space) => (
      space.id === selectedContextDraft.id ? { ...space, ...patch, updatedAt: Date.now() } : space
    )));
  };

  const saveContexts = () => {
    const normalized = contextDrafts.map((space) => ({
      ...space,
      name: space.name.trim() || 'Untitled context',
      description: space.description?.trim(),
      sessionIds: Array.from(new Set(space.sessionIds)),
      updatedAt: Date.now(),
    }));
    onContextSpacesChange(normalized);
    showLocalToast('Context saved.');
  };

  const addSessionToContext = (session: DashboardSessionSummary, spaceId: string) => {
    onContextSpacesChange(contextSpaces.map((space) => (
      space.id === spaceId
        ? { ...space, sessionIds: Array.from(new Set([...space.sessionIds, session.id])), updatedAt: Date.now() }
        : space
    )));
    setRowMenuKey(null);
    onNotify?.('Reunión añadida al contexto.');
  };

  const saveSessionContextSpaces = (session: DashboardSessionSummary, spaceIds: string[]) => {
    const spaceSet = new Set(spaceIds);
    onContextSpacesChange(contextSpaces.map((space) => {
      const hasNow = space.sessionIds.includes(session.id);
      const wantsNow = spaceSet.has(space.id);
      if (hasNow === wantsNow) return space;
      return {
        ...space,
        sessionIds: wantsNow
          ? Array.from(new Set([...space.sessionIds, session.id]))
          : space.sessionIds.filter((id) => id !== session.id),
        updatedAt: Date.now(),
      };
    }));
    setContextPickerSession(null);
    onNotify?.('Contextos actualizados.');
  };

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
        className={`dashboard-meeting-row-wrap ${menuOpen ? 'is-menu-open' : ''}`}
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
                Ver detalles
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRowMenuKey(null);
                  void copyTranscriptForSession(session);
                }}
              >
                Copiar transcripción
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRowMenuKey(null);
                  void copySummaryForSession(session);
                }}
              >
                Copiar resumen
              </button>
              {contextSpaces.length ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setRowMenuKey(null);
                    setContextPickerSession(session);
                  }}
                >
                  Añadir a contexto…
                </button>
              ) : null}
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
          <div className="dashboard-window-controls" aria-label="Window controls">
            <button
              type="button"
              className="wc-btn wc-btn--close"
              onClick={() => void window.meetingAssistant.windowControls.close()}
              aria-label="Close window"
            />
            <button
              type="button"
              className="wc-btn wc-btn--minimize"
              onClick={() => void window.meetingAssistant.windowControls.minimize()}
              aria-label="Minimize window"
            />
            <button
              type="button"
              className="wc-btn wc-btn--maximize"
              onClick={() => void window.meetingAssistant.windowControls.toggleMaximize()}
              aria-label="Maximize window"
            />
          </div>
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
                  <span>Workspace local</span>
                </div>
                <div className="profile-dropdown-group" role="group">
                  <button type="button" role="menuitem" className="profile-dropdown-item" onClick={() => openProfileModal('prompts')}>
                    <span className="profile-dropdown-item-name">Prompts</span>
                    <span className="profile-dropdown-item-desc">Instrucciones del asistente</span>
                  </button>
                  <button type="button" role="menuitem" className="profile-dropdown-item" onClick={() => openProfileModal('contexts')}>
                    <span className="profile-dropdown-item-name">Contextos</span>
                    <span className="profile-dropdown-item-desc">Espacios de reuniones</span>
                  </button>
                  <button type="button" role="menuitem" className="profile-dropdown-item" onClick={() => openProfileModal('settings')}>
                    <span className="profile-dropdown-item-name">Ajustes</span>
                    <span className="profile-dropdown-item-desc">Audio, idioma y más</span>
                  </button>
                  <button type="button" role="menuitem" className="profile-dropdown-item" onClick={() => openProfileModal('account')}>
                    <span className="profile-dropdown-item-name">Cuenta</span>
                    <span className="profile-dropdown-item-desc">Perfil local</span>
                  </button>
                </div>
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
                  <span className="dashboard-profile-theme-toggle-label">Modo oscuro</span>
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
                  Cerrar sesión
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
                  aria-label="Ver todas las reuniones"
                  title="Ver todas las reuniones"
                  onClick={() => {
                    setRowMenuKey((k) => (k?.startsWith('home:') ? null : k));
                    setMeetingsLibraryOpen(true);
                  }}
                >
                  <IconMore />
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

      {contextPickerSession ? (
        <AddToContextModal
          session={contextPickerSession}
          contextSpaces={contextSpaces}
          onClose={() => setContextPickerSession(null)}
          onSave={(spaceIds) => saveSessionContextSpaces(contextPickerSession, spaceIds)}
        />
      ) : null}

      {localToast ? (
        <div className="premium-toast" role="status" aria-live="polite">{localToast}</div>
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
                {profileModal === 'contexts' && 'Contextos'}
                {profileModal === 'settings' && 'Settings'}
                {profileModal === 'account' && 'Account'}
              </h2>
              <button type="button" aria-label="Close" onClick={closeProfileModal}>
                ×
              </button>
            </header>
            <div className="dashboard-shell-modal-body">
              {profileModal === 'settings' ? (
                <div className="dashboard-modal-form">
                  <p className="muted">Preferencias locales.</p>
                  <label className="dashboard-modal-field">
                    <span>Idioma</span>
                    <select value={appLanguage} onChange={(event) => onAppLanguageChange(event.target.value as AppLanguage)}>
                      <option value="es">Español</option>
                      <option value="en">English</option>
                    </select>
                  </label>
                  <p className="muted small">Los modelos de transcripción e IA quedan preparados para configurarse aquí más adelante.</p>
                  <div className="dashboard-modal-inline-actions">
                    <button type="button" className="dashboard-shadcn-primary" onClick={closeProfileModal}>Guardar</button>
                  </div>
                </div>
              ) : profileModal === 'contexts' ? (
                <div className="dashboard-contexts-editor">
                  <aside className="dashboard-contexts-sidebar">
                    {contextDrafts.map((space) => (
                      <button
                        key={space.id}
                        type="button"
                        className={space.id === selectedContextDraft?.id ? 'is-active' : ''}
                        onClick={() => setSelectedContextDraftId(space.id)}
                      >
                        {space.name}
                        {space.sessionIds.length > 0 ? (
                          <span>{space.sessionIds.length}</span>
                        ) : null}
                      </button>
                    ))}
                    <button type="button" className="secondary" onClick={addContextSpace}>+ Nuevo espacio</button>
                  </aside>
                  <div className="dashboard-contexts-main">
                    <div className="dashboard-modal-form">
                    {selectedContextDraft ? (
                      <>
                        <label className="dashboard-modal-field">
                          <span>Nombre</span>
                          <input
                            value={selectedContextDraft.name}
                            disabled={selectedContextDraft.isDefault}
                            onChange={(event) => updateContextDraft({ name: event.target.value })}
                          />
                        </label>
                        <label className="dashboard-modal-field">
                          <span>Notas del contexto</span>
                          <textarea
                            value={selectedContextDraft.description ?? ''}
                            onChange={(event) => updateContextDraft({ description: event.target.value })}
                            rows={4}
                            placeholder="Objetivo, cliente, tema o decisiones que conectan estas reuniones."
                          />
                        </label>
                        <div className="dashboard-modal-field">
                          <span>Reuniones incluidas</span>
                          <div className="dashboard-context-session-list">
                            {selectedContextDraft.sessionIds.length === 0 ? <p className="muted">Todavía no hay reuniones en este contexto.</p> : selectedContextDraft.sessionIds.map((sessionId) => {
                              const session = sessions.find((item) => item.id === sessionId);
                              if (!session) return null;
                              return (
                                <div key={sessionId} className="dashboard-context-session-row">
                                  <span>{session.title}</span>
                                  <button
                                    type="button"
                                    aria-label={`Quitar ${session.title}`}
                                    onClick={() => updateContextDraft({ sessionIds: selectedContextDraft.sessionIds.filter((id) => id !== sessionId) })}
                                  >
                                    × Quitar
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div className="dashboard-modal-inline-actions">
                          {!selectedContextDraft.isDefault ? (
                            <button
                              type="button"
                              className="secondary"
                              style={{ marginRight: 'auto', color: '#dc2626' }}
                              onClick={() => {
                                const remaining = contextDrafts.filter((d) => d.id !== selectedContextDraft.id);
                                setContextDrafts(remaining);
                                onContextSpacesChange(remaining);
                                setSelectedContextDraftId(remaining[0]?.id ?? 'general');
                                showLocalToast('Context deleted.');
                              }}
                            >
                              Delete
                            </button>
                          ) : null}
                          <button type="button" className="dashboard-shadcn-primary" onClick={saveContexts}>Guardar</button>
                        </div>
                      </>
                    ) : null}
                    </div>
                  </div>
                </div>
              ) : profileModal === 'account' ? (
                <div className="dashboard-modal-form">
                  <p className="muted">Perfil local. No crea una cuenta remota.</p>
                  <label className="dashboard-modal-field">
                    <span>Nombre</span>
                    <input value={accountDraft.name} onChange={(event) => setAccountDraft((current) => ({ ...current, name: event.target.value }))} />
                  </label>
                  <label className="dashboard-modal-field">
                    <span>Rol</span>
                    <input value={accountDraft.role ?? ''} onChange={(event) => setAccountDraft((current) => ({ ...current, role: event.target.value }))} placeholder="Founder, PM, engineer..." />
                  </label>
                  <label className="dashboard-modal-field">
                    <span>Organización</span>
                    <input value={accountDraft.organization ?? ''} onChange={(event) => setAccountDraft((current) => ({ ...current, organization: event.target.value }))} />
                  </label>
                  <label className="dashboard-modal-field">
                    <span>Email opcional</span>
                    <input value={accountDraft.email ?? ''} onChange={(event) => setAccountDraft((current) => ({ ...current, email: event.target.value }))} />
                  </label>
                  <div className="dashboard-modal-inline-actions">
                    <button type="button" className="dashboard-shadcn-primary" onClick={saveAccount}>Guardar</button>
                  </div>
                </div>
              ) : (
                <div className="dashboard-modal-form dashboard-prompts-form">
                  <p className="muted">Define cómo responde el asistente durante una reunión.</p>
                  <label className="dashboard-modal-field">
                    <span>Perfil</span>
                    <select value={selectedPromptDraft.id} onChange={(event) => onSelectedPromptProfileIdChange(event.target.value)}>
                      {promptDrafts.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                    </select>
                  </label>
                  <label className="dashboard-modal-field">
                    <span>Nombre del perfil</span>
                    <input value={selectedPromptDraft.name} onChange={(event) => updatePromptDraft({ name: event.target.value })} />
                  </label>
                  <label className="dashboard-modal-field">
                    <span>System prompt</span>
                    <textarea value={selectedPromptDraft.systemPrompt} onChange={(event) => updatePromptDraft({ systemPrompt: event.target.value })} rows={5} />
                  </label>
                  <label className="dashboard-modal-field">
                    <span>Reglas del asistente</span>
                    <textarea value={selectedPromptDraft.contextPrompt} onChange={(event) => updatePromptDraft({ contextPrompt: event.target.value })} rows={4} />
                  </label>
                  <div className="dashboard-modal-inline-actions">
                    <button type="button" className="secondary" onClick={addPromptProfile}>Nuevo perfil</button>
                    <button type="button" className="secondary" onClick={() => updatePromptDraft({ systemPrompt: DEFAULT_PROMPT_PROFILE.systemPrompt, contextPrompt: DEFAULT_PROMPT_PROFILE.contextPrompt })}>Restaurar default</button>
                    <button type="button" className="dashboard-shadcn-primary" onClick={savePrompts}>Guardar</button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
