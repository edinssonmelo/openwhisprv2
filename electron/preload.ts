import { contextBridge, ipcRenderer } from 'electron';

const openwhisprOverlayWindow = process.env.OPENWHISPR_OVERLAY_WINDOW === 'true';

contextBridge.exposeInMainWorld('meetingAssistant', {
  overlayWindow: openwhisprOverlayWindow,
  windowControls: {
    setAppMode: (mode: 'dashboard' | 'session-boot' | 'session') =>
      ipcRenderer.invoke('window:set-app-mode', mode) as Promise<{ ok: boolean }>,
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
  platform: {
    getInfo: () => ipcRenderer.invoke('platform:get-info'),
  },
  audio: {
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
    transcribeBlock: (payload: {
      blockId: string;
      wavBytes: Uint8Array;
      startMs: number;
      endMs: number;
      rms: number;
      peak?: number;
      sampleRate?: number;
      sampleCount?: number;
      whisperGain?: number;
      source: 'mic' | 'system' | 'mixed';
      glossary?: string;
      promptMode?: 'empty' | 'minimal' | 'contextual';
      mode?: 'preview' | 'final' | 'benchmark';
      modelRole?: 'preview' | 'final';
      language?: 'es' | 'auto';
      verbatimOnly?: boolean;
    }) => ipcRenderer.invoke('transcription:transcribe-block', payload),
    cancelPending: () => ipcRenderer.invoke('transcription:cancel-pending'),
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
});
