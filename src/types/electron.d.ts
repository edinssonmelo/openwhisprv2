import type { AsrLiveEvent, AsrSessionStatus } from '../transcription/types';

export {};

declare global {
  /** Result of `transcription.checkSetup` (main: getWhisperSetupStatus). */
  interface AsrSetupStatus {
    /** At least one live engine (Parakeet helper or whisper.cpp) is available. */
    ok: boolean;
    whisperOk: boolean;
    parakeetHelperConfigured: boolean;
    parakeetModelsPresent: boolean;
    parakeetHelperPath: string;
    parakeetModelDir: string;
    asr: AsrSessionStatus;
    missing: string[];
    cliPath: string;
    modelPath: string;
    message: string;
    activeModelName?: string | null;
    refinementMode?: 'off' | 'whisper-only' | 'whisper-qwen';
    refinerModel?: string;
    modelCandidates?: Array<{
      name: string;
      path: string;
      exists: boolean;
    }>;
  }

  type UpdateStatus =
    | { state: 'idle' }
    | { state: 'checking' }
    | { state: 'available'; version: string }
    | { state: 'not-available'; version: string }
    | { state: 'downloading'; percent: number }
    | { state: 'ready'; version: string }
    | { state: 'error'; message: string };

  interface Window {
    meetingAssistant: {
      /** True when Electron started with OPENWHISPR_OVERLAY_WINDOW=true (sync, for first-frame transparency). */
      overlayWindow: boolean;
      windowControls: {
        setAppMode: (mode: 'dashboard' | 'session-boot' | 'session') => Promise<{ ok: boolean }>;
        minimize: () => Promise<{ ok: boolean }>;
        toggleMaximize: () => Promise<{ ok: boolean; maximized: boolean }>;
        close: () => Promise<{ ok: boolean }>;
        expandSessionOverlay: () => void;
      };
      clipboard: {
        writeText: (text: string) => Promise<{ ok: boolean }>;
      };
      overlay: {
        setPointerPassthrough: (ignore: boolean) => void;
      };
      updates: {
        check: () => Promise<{ ok: boolean; reason?: string; message?: string }>;
        getStatus: () => Promise<UpdateStatus>;
        quitAndInstall: () => Promise<{ ok: boolean }>;
        onStatus: (callback: (status: UpdateStatus) => void) => () => void;
      };
      telemetry: {
        getConsent: () => Promise<{ consent: boolean; installId: string; endpointConfigured: boolean }>;
        setConsent: (consent: boolean) => Promise<{ ok: boolean; consent: boolean }>;
        track: (event: string, props?: Record<string, unknown>) => Promise<{ ok: boolean }>;
        getInstallId: () => Promise<string>;
      };
      feedback: {
        submit: (payload: {
          message: string;
          email?: string;
          includeLogs?: boolean;
        }) => Promise<{ ok: boolean; reason?: string }>;
        openExternal: () => Promise<{ ok: boolean }>;
      };
      platform: {
        getInfo: () => Promise<{
          platform: NodeJS.Platform;
          versions: Record<string, string>;
          /** True when Electron was started with OPENWHISPR_OVERLAY_WINDOW=true */
          overlayWindow: boolean;
          mediaAccess: {
            microphone: string;
            screen: string;
          } | null;
        }>;
      };
      audio: {
        ensureMicrophoneAccess: () => Promise<{ ok: boolean; status: string }>;
        getDesktopSources: () => Promise<{
          sources: Array<{
            id: string;
            name: string;
            thumbnailDataUrl: string | null;
          }>;
          error: string | null;
        }>;
      };
      systemAudioHelper: {
        check: () => Promise<{
          ok: boolean;
          path?: string;
          error?: string;
          running?: boolean;
        }>;
        start: () => Promise<{
          ok: boolean;
          path?: string;
          error?: string;
          alreadyRunning?: boolean;
        }>;
        stop: () => Promise<{
          ok: boolean;
          error?: string;
        }>;
        onChunk: (callback: (payload: {
          sequence: number;
          version: number;
          sampleRate: number;
          channels: number;
          frameCount: number;
          pcm: Uint8Array;
        }) => void) => () => void;
        onStatus: (callback: (payload: {
          status: 'stopped' | 'failed';
          code?: number | null;
          signal?: string | null;
          error?: string;
        }) => void) => () => void;
      };
      coreAudioTapHelper: {
        check: () => Promise<{
          ok: boolean;
          path?: string;
          error?: string;
          running?: boolean;
        }>;
        start: () => Promise<{
          ok: boolean;
          path?: string;
          error?: string;
          alreadyRunning?: boolean;
        }>;
        stop: () => Promise<{
          ok: boolean;
          error?: string;
        }>;
        onChunk: (callback: (payload: {
          sequence: number;
          version: number;
          sampleRate: number;
          channels: number;
          frameCount: number;
          pcm: Uint8Array;
        }) => void) => () => void;
        onStatus: (callback: (payload: {
          status: 'stopped' | 'failed';
          code?: number | null;
          signal?: string | null;
          error?: string;
        }) => void) => () => void;
      };
      displayCapture: {
        setPreferredSourceId: (sourceId: string | null) => void;
      };
      files: {
        saveWav: (payload: { bytes: Uint8Array; fileName?: string }) => Promise<{
          path: string;
          fileUrl: string;
        }>;
      };
      transcription: {
        checkSetup: () => Promise<AsrSetupStatus>;
      };
      asr: {
        status: () => Promise<AsrSessionStatus>;
        prepare: () => Promise<AsrSessionStatus>;
        start: (payload: {
          sessionId: string;
          generation: number;
          language: 'es' | 'en' | 'auto';
          sources: { mic: boolean; system: boolean };
        }) => Promise<{ ok: boolean; status: AsrSessionStatus; error?: string }>;
        stop: (reason?: string) => Promise<{
          ok: boolean;
          drained: Extract<AsrLiveEvent, { type: 'drained' }> | null;
          status: AsrSessionStatus;
        }>;
        push: (payload: {
          sessionId: string;
          generation: number;
          source: 'mic' | 'system';
          sampleRate: number;
          pcm: Float32Array;
        }) => void;
        onEvent: (callback: (event: AsrLiveEvent) => void) => () => void;
        onStatus: (callback: (status: AsrSessionStatus) => void) => () => void;
      };
      polisher: {
        check: () => Promise<{
          ok: boolean;
          model: string;
          message: string;
        }>;
        polishSegment: (payload: {
          batchId: string;
          rawSegments: Array<{
            id: string;
            startMs: number;
            endMs: number;
            text: string;
            qwenText?: string;
            source: 'mic' | 'system' | 'mixed';
            rms: number;
          }>;
          context: string;
          glossary: string;
          refinementMode?: 'off' | 'whisper-only' | 'whisper-qwen';
          prompt?: string;
          numPredict?: number;
        }) => Promise<{
          ok: boolean;
          batchId: string;
          text?: string;
          error?: string;
          durationMs: number;
        }>;
      };
      assistant: {
        ask: (payload: {
          question: string;
          transcriptContext: string;
          refinedContext?: string;
        }) => Promise<{
          ok: boolean;
          text?: string;
          error?: string;
          durationMs: number;
        }>;
      };
      db: {
        listSessions: () => Promise<{ ok: boolean; sessions: Record<string, unknown>[]; error?: string }>;
        upsertSession: (session: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
        deleteSession: (id: string) => Promise<{ ok: boolean; error?: string }>;
        migrateLegacySessions: (
          sessions: Record<string, unknown>[],
        ) => Promise<{ ok: boolean; migrated: number; error?: string }>;
      };
    };
  }
}
