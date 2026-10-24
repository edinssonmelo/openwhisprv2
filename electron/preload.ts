import { contextBridge, ipcRenderer } from 'electron';

const openwhisprOverlayWindow = process.env.OPENWHISPR_OVERLAY_WINDOW === 'true';

contextBridge.exposeInMainWorld('meetingAssistant', {
  overlayWindow: openwhisprOverlayWindow,
  windowControls: {
    setAppMode: (mode: 'dashboard' | 'session-boot' | 'session') =>
      ipcRenderer.invoke('window:set-app-mode', mode) as Promise<{ ok: boolean }>,
    minimize: () => ipcRenderer.invoke('window:minimize') as Promise<{ ok: boolean }>,
    toggleMaximize: () => ipcRenderer.invoke('window:maximize-toggle') as Promise<{ ok: boolean; maximized: boolean }>,
    close: () => ipcRenderer.invoke('window:close') as Promise<{ ok: boolean }>,
    /** After capture/display picker completes — expands overlay to full display (overlay window only). */
    expandSessionOverlay: () => {
      ipcRenderer.send('window:session-overlay-expand');
    },
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text) as Promise<{ ok: boolean }>,
  },
  overlay: {
    /** true = enviar eventos al sistema (clicks pasan “por detrás”); false = ventana recibe clics. */
    setPointerPassthrough: (ignore: boolean) => ipcRenderer.send('overlay:set-pointer-pass-through', ignore),
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    getStatus: () => ipcRenderer.invoke('updates:get-status'),
    quitAndInstall: () => ipcRenderer.invoke('updates:quit-and-install'),
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
      ipcRenderer.on('updates:status', listener);
      return () => ipcRenderer.removeListener('updates:status', listener);
    },
  },
  telemetry: {
    getConsent: () => ipcRenderer.invoke('telemetry:get-consent'),
    setConsent: (consent: boolean) => ipcRenderer.invoke('telemetry:set-consent', consent),
    track: (event: string, props?: Record<string, unknown>) =>
      ipcRenderer.invoke('telemetry:track', event, props),
    getInstallId: () => ipcRenderer.invoke('telemetry:get-install-id'),
  },
  feedback: {
    submit: (payload: { message: string; email?: string; includeLogs?: boolean }) =>
      ipcRenderer.invoke('feedback:submit', payload),
    openExternal: () => ipcRenderer.invoke('feedback:open-external'),
  },
  platform: {
    getInfo: () => ipcRenderer.invoke('platform:get-info'),
  },
  audio: {
    ensureMicrophoneAccess: () =>
      ipcRenderer.invoke('audio:ensure-microphone-access') as Promise<{ ok: boolean; status: string }>,
    getDesktopSources: () => ipcRenderer.invoke('audio:get-desktop-sources'),
  },
  systemAudioHelper: {
    check: () => ipcRenderer.invoke('system-audio-helper:check'),
    start: () => ipcRenderer.invoke('system-audio-helper:start'),
    stop: () => ipcRenderer.invoke('system-audio-helper:stop'),
    onChunk: (callback: (payload: {
      sequence: number;
      version: number;
      sampleRate: number;
      channels: number;
      frameCount: number;
      pcm: Uint8Array;
    }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: {
        sequence: number;
        version: number;
        sampleRate: number;
        channels: number;
        frameCount: number;
        pcm: Uint8Array;
      }) => callback(payload);
      ipcRenderer.on('system-audio-helper:chunk', listener);
      return () => ipcRenderer.removeListener('system-audio-helper:chunk', listener);
    },
    onStatus: (callback: (payload: {
      status: 'stopped' | 'failed';
      code?: number | null;
      signal?: string | null;
      error?: string;
    }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: {
        status: 'stopped' | 'failed';
        code?: number | null;
        signal?: string | null;
        error?: string;
      }) => callback(payload);
      ipcRenderer.on('system-audio-helper:status', listener);
      return () => ipcRenderer.removeListener('system-audio-helper:status', listener);
    },
  },
  coreAudioTapHelper: {
    check: () => ipcRenderer.invoke('core-audio-tap-helper:check'),
    start: () => ipcRenderer.invoke('core-audio-tap-helper:start'),
    stop: () => ipcRenderer.invoke('core-audio-tap-helper:stop'),
    onChunk: (callback: (payload: {
      sequence: number;
      version: number;
      sampleRate: number;
      channels: number;
      frameCount: number;
      pcm: Uint8Array;
    }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: {
        sequence: number;
        version: number;
        sampleRate: number;
        channels: number;
        frameCount: number;
        pcm: Uint8Array;
      }) => callback(payload);
      ipcRenderer.on('core-audio-tap-helper:chunk', listener);
      return () => ipcRenderer.removeListener('core-audio-tap-helper:chunk', listener);
    },
    onStatus: (callback: (payload: {
      status: 'stopped' | 'failed';
      code?: number | null;
      signal?: string | null;
      error?: string;
    }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: {
        status: 'stopped' | 'failed';
        code?: number | null;
        signal?: string | null;
        error?: string;
      }) => callback(payload);
      ipcRenderer.on('core-audio-tap-helper:status', listener);
      return () => ipcRenderer.removeListener('core-audio-tap-helper:status', listener);
    },
  },
  displayCapture: {
    /** Tell main which screen/window to use for `getDisplayMedia` when the custom handler runs (matches Settings dropdown). */
    setPreferredSourceId: (sourceId: string | null) => {
      ipcRenderer.send('display-capture:set-preferred-source-id', sourceId ?? '');
    },
  },
  files: {
    saveWav: (payload: { bytes: Uint8Array; fileName?: string }) => ipcRenderer.invoke('files:save-wav', payload),
  },
  transcription: {
    checkSetup: () => ipcRenderer.invoke('transcription:check-setup'),
  },
  /**
   * Live ASR session (main process owns VAD, engines and drain). The renderer only streams mic PCM and
   * consumes typed events; system audio is fed to the session inside main by the native helpers.
   */
  asr: {
    status: () => ipcRenderer.invoke('asr:status'),
    prepare: () => ipcRenderer.invoke('asr:prepare'),
    start: (payload: {
      sessionId: string;
      generation: number;
      language: 'es' | 'en' | 'auto';
      sources: { mic: boolean; system: boolean };
    }) => ipcRenderer.invoke('asr:start', payload),
    stop: (reason?: string) => ipcRenderer.invoke('asr:stop', { reason }),
    push: (payload: {
      sessionId: string;
      generation: number;
      source: 'mic' | 'system';
      sampleRate: number;
      pcm: Float32Array;
    }) => {
      ipcRenderer.send('asr:push', payload);
    },
    onEvent: (callback: (event: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on('asr:event', listener);
      return () => ipcRenderer.removeListener('asr:event', listener);
    },
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on('asr:status', listener);
      return () => ipcRenderer.removeListener('asr:status', listener);
    },
  },
  polisher: {
    check: () => ipcRenderer.invoke('polisher:check'),
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
    }) => ipcRenderer.invoke('polisher:polish-segment', payload),
  },
  assistant: {
    ask: (payload: {
      question: string;
      transcriptContext: string;
      refinedContext?: string;
    }) => ipcRenderer.invoke('assistant:ask', payload),
  },
  db: {
    listSessions: () =>
      ipcRenderer.invoke('db:sessions:list') as Promise<{ ok: boolean; sessions: Record<string, unknown>[]; error?: string }>,
    upsertSession: (session: Record<string, unknown>) =>
      ipcRenderer.invoke('db:sessions:upsert', session) as Promise<{ ok: boolean; error?: string }>,
    deleteSession: (id: string) =>
      ipcRenderer.invoke('db:sessions:delete', id) as Promise<{ ok: boolean; error?: string }>,
    migrateLegacySessions: (sessions: Record<string, unknown>[]) =>
      ipcRenderer.invoke('db:sessions:migrate-legacy', sessions) as Promise<{ ok: boolean; migrated: number; error?: string }>,
  },
});
