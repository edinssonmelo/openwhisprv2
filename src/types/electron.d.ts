export {};

declare global {
  interface Window {
    meetingAssistant: {
      platform: {
        getInfo: () => Promise<{
          platform: NodeJS.Platform;
          versions: Record<string, string>;
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
            source: 'mic' | 'system' | 'mixed';
            rms: number;
          }>;
          context: string;
          glossary: string;
        }) => Promise<{
          ok: boolean;
          batchId: string;
          text?: string;
          error?: string;
          durationMs: number;
        }>;
      };
    };
  }
}
