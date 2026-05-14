export {};

declare global {
  interface Window {
    meetingAssistant: {
      /** True when Electron started with OPENWHISPR_OVERLAY_WINDOW=true (sync, for first-frame transparency). */
      overlayWindow: boolean;
      windowControls: {
        setAppMode: (mode: 'dashboard' | 'session-boot' | 'session') => Promise<{ ok: boolean }>;
        expandSessionOverlay: () => void;
      };
      clipboard: {
        writeText: (text: string) => Promise<{ ok: boolean }>;
      };
      overlay: {
        setPointerPassthrough: (ignore: boolean) => void;
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
        checkSetup: () => Promise<{
          ok: boolean;
          missing: string[];
          cliPath: string;
          modelPath: string;
          message: string;
          activeModelName?: string | null;
          previewModelName?: string | null;
          finalModelName?: string | null;
          pipelineMode?: 'baseline-whisper' | 'moonshine-qwen-v2';
          moonshineConfigured?: boolean;
          qwenConfigured?: boolean;
          experimentalPreview?: boolean;
          finalEngine?: 'whisper' | 'qwen' | 'compare';
          refinementMode?: 'off' | 'whisper-only' | 'whisper-qwen';
          refinerModel?: string;
          modelCandidates?: Array<{
            name: string;
            path: string;
            exists: boolean;
          }>;
        }>;
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
        }) => Promise<{
          ok: boolean;
          blockId: string;
          text?: string;
          resolvedText?: string;
          replacements?: Array<{
            original: string;
            replacement: string;
            confidence: number;
            reason: string;
          }>;
          whisperPromptLength?: number;
          error?: string;
          durationMs: number;
          stderr?: string;
          modelName?: string;
          modelPath?: string;
          engineUsed?: 'whisper-large-v3-turbo' | 'moonshine' | 'qwen3-asr';
          fallbackUsed?: boolean;
          fallbackReason?: string;
          whisperText?: string;
          qwenText?: string;
          whisperDurationMs?: number;
          qwenDurationMs?: number;
          qwenError?: string;
          whisperDebug?: {
            language: 'es' | 'auto';
            promptLength: number;
            verbatimOnly: boolean;
            translateEnabled: false;
            argsSanitized: string[];
          };
        }>;
        cancelPending: () => Promise<{
          ok: boolean;
          cancelled: number;
        }>;
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
    };
  }
}
