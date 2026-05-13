import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useOverlayPointerPassthrough } from '../hooks/useOverlayPointerPassthrough';
import { AiOverlayPanel } from './AiOverlayPanel';
import type { AssistantChatMessage } from './AssistantChatPanel';
import { LiveTranscriptPanel } from './LiveTranscriptPanel';
import { OverlayStage } from './OverlayStage';
import { SessionFloatingFrame } from './SessionFloatingFrame';
import { TopControlBar } from './TopControlBar';
import type { CapturePreference } from '../storage/appPreferences';

interface FloatingAssistantShellProps {
  statusLabel: string;
  statusTone: 'idle' | 'recording' | 'processing' | 'interrupted' | 'recovering';
  timerLabel: string;
  askShortcutLabel: string;
  hideShortcutLabel: string;
  isCapturing: boolean;
  overlayCollapsed: boolean;
  aiPanelOpen: boolean;
  transcriptText: string;
  refinedText: string;
  transcriptView: 'live' | 'refined';
  refinementAvailable: boolean;
  localAiReady: boolean;
  chatMessages: AssistantChatMessage[];
  chatInput: string;
  chatBusy: boolean;
  chatError: string | null;
  reconnectAudioVisible?: boolean;
  onTranscriptViewChange: (view: 'live' | 'refined') => void;
  onCopyTranscript: () => void;
  onChatInputChange: (value: string) => void;
  onChatSubmit: () => void;
  onCopyLastAiResponse: () => void;
  onOpenAiPanel: () => void;
  onCloseAiPanel: () => void;
  onToggleCapture: () => void;
  onToggleOverlay: () => void;
  onReconnectAudio?: () => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  /** Increment (or change) to scroll the settings panel to the Audio section after open. */
  settingsAudioScrollNonce: number;
  onHome: () => void;
  onOpenAudioSettings: () => void;
  onEndSession: () => void;
  capturePreference: CapturePreference;
  onCapturePreferenceChange: (mode: CapturePreference) => void;
  transcriptListeningHint?: string;
  homeConfirmDialog: ReactNode;
  settings: ReactNode;
  debug: ReactNode;
}

export function FloatingAssistantShell({
  statusLabel,
  statusTone,
  timerLabel,
  askShortcutLabel,
  hideShortcutLabel,
  isCapturing,
  overlayCollapsed,
  aiPanelOpen,
  transcriptText,
  refinedText,
  transcriptView,
  refinementAvailable,
  localAiReady,
  chatMessages,
  chatInput,
  chatBusy,
  chatError,
  reconnectAudioVisible = false,
  onTranscriptViewChange,
  onCopyTranscript,
  onChatInputChange,
  onChatSubmit,
  onCopyLastAiResponse,
  onOpenAiPanel,
  onCloseAiPanel,
  onToggleCapture,
  onToggleOverlay,
  onReconnectAudio,
  settingsOpen,
  onSettingsOpenChange,
  settingsAudioScrollNonce,
  onHome,
  onOpenAudioSettings,
  onEndSession,
  capturePreference,
  onCapturePreferenceChange,
  transcriptListeningHint,
  homeConfirmDialog,
  settings,
  debug,
}: FloatingAssistantShellProps) {
  const lastAudioScrollNonceRef = useRef(0);

  useLayoutEffect(() => {
    if (!settingsOpen) return;
    if (settingsAudioScrollNonce === 0) return;
    if (lastAudioScrollNonceRef.current === settingsAudioScrollNonce) return;
    lastAudioScrollNonceRef.current = settingsAudioScrollNonce;
    window.requestAnimationFrame(() => {
      document.getElementById('settings-section-audio')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [settingsOpen, settingsAudioScrollNonce]);

  useOverlayPointerPassthrough(settingsOpen, `${overlayCollapsed}-${aiPanelOpen}`);

  const toggleAiPanel = () => {
    if (aiPanelOpen) onCloseAiPanel();
    else onOpenAiPanel();
  };

  const controlBar = (
    <TopControlBar
      variant="embedded"
      statusTone={statusTone}
      timerLabel={timerLabel}
      askShortcutLabel={askShortcutLabel}
      hideShortcutLabel={hideShortcutLabel}
      isCapturing={isCapturing}
      isCollapsed={overlayCollapsed}
      aiPanelOpen={aiPanelOpen}
      reconnectAudioVisible={reconnectAudioVisible}
      onToggleCapture={onToggleCapture}
      onToggleAiPanel={toggleAiPanel}
      onToggleCollapse={onToggleOverlay}
      onHome={onHome}
      onOpenAllSettings={() => onSettingsOpenChange(true)}
      onOpenAudioSettings={onOpenAudioSettings}
      onEndSession={onEndSession}
      capturePreference={capturePreference}
      onCapturePreferenceChange={onCapturePreferenceChange}
      onReconnectAudio={onReconnectAudio}
    />
  );

  return (
    <main className={`floating-page ${overlayCollapsed ? 'overlay-collapsed' : ''} ${settingsOpen ? 'settings-open' : ''}`}>
      {homeConfirmDialog}
      <OverlayStage>
        <SessionFloatingFrame collapsed={overlayCollapsed}>
          {!overlayCollapsed ? (
            <>
              <div className="session-frame-left">
                <LiveTranscriptPanel
                  text={transcriptText}
                  refinedText={refinedText}
                  activeView={transcriptView}
                  onViewChange={onTranscriptViewChange}
                  refinementAvailable={refinementAvailable}
                  footerStatusLabel={statusLabel}
                  listeningHint={transcriptListeningHint}
                  onCopy={onCopyTranscript}
                />
              </div>
              <div className="session-frame-right">
                {controlBar}
                {aiPanelOpen ? (
                  <div className="overlay-right-stack">
                    <AiOverlayPanel
                      open={aiPanelOpen}
                      messages={chatMessages}
                      input={chatInput}
                      busy={chatBusy}
                      error={chatError}
                      localAiReady={localAiReady}
                      onInputChange={onChatInputChange}
                      onSubmit={onChatSubmit}
                      onClose={onCloseAiPanel}
                      onCopyLastResponse={onCopyLastAiResponse}
                    />
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="session-frame-right session-frame-right--bar-only">
              {controlBar}
            </div>
          )}
        </SessionFloatingFrame>

        <aside className="settings-overlay">
          <div className="settings-shell glass-panel">
            <div className="panel-title-row">
              <div>
                <h2>Configuración</h2>
                <p>Captura, dispositivos y depuración</p>
              </div>
              <button
                type="button"
                className="round-close-button"
                aria-label="Cerrar configuración"
                onClick={() => onSettingsOpenChange(false)}
              >
                ×
              </button>
            </div>
            <div className="settings-scroll custom-scrollbar">
              {settings}
              <details className="debug-section">
                <summary>Laboratorio y depuración</summary>
                {debug}
              </details>
            </div>
          </div>
        </aside>
      </OverlayStage>
    </main>
  );
}
