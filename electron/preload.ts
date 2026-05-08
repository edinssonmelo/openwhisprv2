import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('meetingAssistant', {
  platform: {
    getInfo: () => ipcRenderer.invoke('platform:get-info'),
  },
  audio: {
    getDesktopSources: () => ipcRenderer.invoke('audio:get-desktop-sources'),
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
        source: 'mic' | 'system' | 'mixed';
        rms: number;
      }>;
      context: string;
      glossary: string;
    }) => ipcRenderer.invoke('polisher:polish-segment', payload),
  },
});
