export type SystemAudioPlatform = 'macos' | 'windows' | 'linux' | 'unknown';

export type SystemAudioStrategy =
  | 'auto'
  | 'coreaudio-tap'
  | 'native-electron-loopback'
  | 'native-helper'
  | 'virtual-input';

export type SystemAudioEngineStatus =
  | 'idle'
  | 'probing'
  | 'working'
  | 'silent'
  | 'failed'
  | 'needs-permission'
  | 'needs-helper'
  | 'needs-driver';

export type SystemAudioProviderId =
  | 'coreaudio-tap'
  | 'electron-loopback'
  | 'native-helper'
  | 'virtual-input';

export interface SystemAudioDeviceCandidate {
  deviceId: string;
  groupId?: string;
  label: string;
}

const VIRTUAL_LABEL_MARKERS = [
  'blackhole',
  'loopback',
  'soundflower',
  'vb-cable',
  'vb cable',
  'openwhispr audio',
  'stereo mix',
  'what u hear',
];

export function isVirtualSystemInputLabel(label: string): boolean {
  const t = label.toLowerCase();
  return VIRTUAL_LABEL_MARKERS.some((m) => t.includes(m));
}

export function filterVirtualSystemInputCandidates(candidates: SystemAudioDeviceCandidate[]): SystemAudioDeviceCandidate[] {
  return candidates.filter(
    (d) =>
      d.deviceId
      && d.deviceId !== 'default'
      && !d.deviceId.toLowerCase().includes('default')
      && isVirtualSystemInputLabel(d.label),
  );
}

/** Native macOS helper emits PCM via IPC; it must not masquerade as a MediaStream. */
export type SystemAudioProviderStartResult =
  | { providerId: 'electron-loopback' | 'virtual-input'; kind: 'media-stream'; stream: MediaStream; modelName?: string }
  | { providerId: 'native-helper' | 'coreaudio-tap'; kind: 'pcm-helper' };

export type SystemAudioEngineResult = SystemAudioProviderStartResult & {
  strategy: SystemAudioStrategy;
  status: SystemAudioEngineStatus;
  rmsProbeResult: 'working' | 'silent' | 'skipped';
  setupHint?: string;
};

export interface SystemAudioEngineProvider {
  id: SystemAudioProviderId;
  available: () => boolean | Promise<boolean>;
  start: (reason: string) => Promise<SystemAudioProviderStartResult>;
}

export class SystemAudioEngineError extends Error {
  status: SystemAudioEngineStatus;
  providerId: SystemAudioProviderId | null;
  setupHint?: string;
  causeError?: unknown;

  constructor(
    message: string,
    options: {
      status: SystemAudioEngineStatus;
      providerId?: SystemAudioProviderId | null;
      setupHint?: string;
      causeError?: unknown;
    },
  ) {
    super(message);
    this.name = 'SystemAudioEngineError';
    this.status = options.status;
    this.providerId = options.providerId ?? null;
    this.setupHint = options.setupHint;
    this.causeError = options.causeError;
  }
}

export interface SystemAudioEngineOptions {
  platform: SystemAudioPlatform;
  strategy: SystemAudioStrategy;
  selectedOutputDevice?: string;
  selectedMicDevice?: string;
  selectedSystemInputId?: string;
  virtualInputCandidates: SystemAudioDeviceCandidate[];
  providers: {
    electronLoopback: SystemAudioEngineProvider;
    coreAudioTap: SystemAudioEngineProvider;
    nativeHelper: SystemAudioEngineProvider;
    virtualInput: (deviceId: string) => SystemAudioEngineProvider;
  };
  probeUsableAudio: (stream: MediaStream, providerId: SystemAudioProviderId) => Promise<boolean>;
  stopPcmHelper?: (providerId: 'native-helper' | 'coreaudio-tap', reason: string) => void;
  probePcmHelper?: (providerId: 'native-helper' | 'coreaudio-tap') => Promise<boolean>;
  stopStream: (stream: MediaStream, reason: string) => void;
  log: (eventName: string, payload: Record<string, unknown>) => void;
}

const MAC_HELPER_HINT =
  'Openwhispr detected your Mac output, but macOS does not expose output audio as an input. Build the CoreAudio Tap helper (npm run build:macos-coreaudio-tap-helper), install BlackHole/VB-CABLE, or use Electron loopback / ScreenCaptureKit (experimental) in Settings.';

function defaultSetupHint(platform: SystemAudioPlatform): string {
  if (platform === 'macos') return MAC_HELPER_HINT;
  if (platform === 'windows') return 'Use the native WASAPI helper or select a VB-CABLE style virtual input.';
  if (platform === 'linux') return 'Use a PipeWire/PulseAudio provider or select a monitor/virtual input.';
  return 'Select a supported native helper or virtual system input.';
}

async function isProviderAvailable(provider: SystemAudioEngineProvider): Promise<boolean> {
  try {
    return Boolean(await provider.available());
  } catch {
    return false;
  }
}

export function pickVirtualSystemInputCandidate(
  selectedSystemInputId: string | undefined,
  virtualInputCandidates: SystemAudioDeviceCandidate[],
): SystemAudioDeviceCandidate | null {
  const allowed = filterVirtualSystemInputCandidates(virtualInputCandidates);
  if (allowed.length === 0) return null;

  if (selectedSystemInputId && selectedSystemInputId !== 'default' && !selectedSystemInputId.toLowerCase().includes('default')) {
    const hit = allowed.find((d) => d.deviceId === selectedSystemInputId);
    if (hit) return hit;
    return null;
  }
  return allowed[0] ?? null;
}

export async function runSystemAudioEngine(options: SystemAudioEngineOptions): Promise<SystemAudioEngineResult> {
  const {
    platform,
    strategy,
    selectedOutputDevice,
    selectedMicDevice,
    selectedSystemInputId,
    virtualInputCandidates,
    providers,
    probeUsableAudio,
    stopPcmHelper,
    probePcmHelper,
    stopStream,
    log,
  } = options;
  const setupHint = defaultSetupHint(platform);
  const virtualCandidate = pickVirtualSystemInputCandidate(selectedSystemInputId, virtualInputCandidates);
  const basePayload = {
    platform,
    strategy,
    selectedOutputDevice: selectedOutputDevice ?? null,
    selectedMicDevice: selectedMicDevice ?? null,
    selectedSystemInputId: selectedSystemInputId ?? '',
    virtualInputCandidates,
    virtualCandidate,
  };

  log('system-audio:engine:start', basePayload);

  const startAndProbe = async (
    provider: SystemAudioEngineProvider,
    reason: string,
    requireProbe = true,
  ): Promise<SystemAudioEngineResult> => {
    log('system-audio:provider:start', { ...basePayload, providerId: provider.id, reason });
    const started = await provider.start(reason);

    if (started.kind === 'pcm-helper') {
      log('system-audio:provider:pcm-helper-live', {
        ...basePayload,
        providerId: started.providerId,
        reason,
        note: 'no MediaStream; PCM arrives via helper IPC',
      });

      if (!requireProbe) {
        log('system-audio:provider:working', { ...basePayload, providerId: started.providerId, reason, rmsProbeResult: 'skipped' });
        return {
          ...started,
          strategy,
          status: 'working',
          rmsProbeResult: 'skipped',
        };
      }

      log('system-audio:provider:rms-probe', { ...basePayload, providerId: started.providerId, reason, mode: 'pcm-helper' });
      const probe = probePcmHelper ?? (async () => true);
      const usable = await probe(started.providerId);
      if (usable) {
        log('system-audio:provider:working', { ...basePayload, providerId: started.providerId, reason, rmsProbeResult: 'working' });
        return {
          ...started,
          strategy,
          status: 'working',
          rmsProbeResult: 'working',
        };
      }

      log('system-audio:provider:silent', { ...basePayload, providerId: started.providerId, reason, rmsProbeResult: 'silent' });
      stopPcmHelper?.(started.providerId, `${started.providerId}-silent`);
      throw new SystemAudioEngineError(
        'System audio helper is running but signal stayed silent.',
        {
          status: 'silent',
          providerId: started.providerId,
          setupHint,
        },
      );
    }

    log('system-audio:provider:stream-live', {
      ...basePayload,
      providerId: started.providerId,
      reason,
      streamId: started.stream.id,
      audioTracks: started.stream.getAudioTracks().map((track) => ({
        id: track.id,
        label: track.label,
        readyState: track.readyState,
        muted: track.muted,
        enabled: track.enabled,
        settings: track.getSettings(),
      })),
    });

    if (!requireProbe) {
      log('system-audio:provider:working', { ...basePayload, providerId: started.providerId, reason, rmsProbeResult: 'skipped' });
      return {
        ...started,
        strategy,
        status: 'working',
        rmsProbeResult: 'skipped',
      };
    }

    log('system-audio:provider:rms-probe', { ...basePayload, providerId: started.providerId, reason });
    const usable = await probeUsableAudio(started.stream, started.providerId);
    if (usable) {
      log('system-audio:provider:working', { ...basePayload, providerId: started.providerId, reason, rmsProbeResult: 'working' });
      return {
        ...started,
        strategy,
        status: 'working',
        rmsProbeResult: 'working',
      };
    }

    log('system-audio:provider:silent', { ...basePayload, providerId: started.providerId, reason, rmsProbeResult: 'silent' });
    stopStream(started.stream, `${started.providerId}-silent`);
    throw new SystemAudioEngineError(
      'System audio stream is live but silent.',
      {
        status: 'silent',
        providerId: started.providerId,
        setupHint,
      },
    );
  };

  const tryVirtualInput = async (reason: string, causeError?: unknown): Promise<SystemAudioEngineResult> => {
    if (!virtualCandidate) {
      log('system-audio:provider:failed', {
        ...basePayload,
        providerId: 'virtual-input',
        reason,
        status: 'needs-driver',
        causeError: String(causeError ?? ''),
      });
      throw new SystemAudioEngineError(
        'No virtual system input is available (no BlackHole / Loopback / VB-CABLE style device detected).',
        {
          status: 'needs-driver',
          providerId: 'virtual-input',
          setupHint,
          causeError,
        },
      );
    }

    return startAndProbe(providers.virtualInput(virtualCandidate.deviceId), reason, true);
  };

  if (strategy === 'virtual-input') {
    return tryVirtualInput('strategy-virtual-input');
  }

  if (strategy === 'coreaudio-tap') {
    if (!(await isProviderAvailable(providers.coreAudioTap))) {
      log('system-audio:provider:failed', { ...basePayload, providerId: 'coreaudio-tap', status: 'needs-helper' });
      throw new SystemAudioEngineError(
        'CoreAudio Tap helper is not built.',
        {
          status: 'needs-helper',
          providerId: 'coreaudio-tap',
          setupHint: 'Run npm run build:macos-coreaudio-tap-helper.',
        },
      );
    }
    return startAndProbe(providers.coreAudioTap, 'strategy-coreaudio-tap', true);
  }

  if (strategy === 'native-helper') {
    if (!(await isProviderAvailable(providers.nativeHelper))) {
      log('system-audio:provider:failed', { ...basePayload, providerId: 'native-helper', status: 'needs-helper' });
      throw new SystemAudioEngineError(
        'ScreenCaptureKit helper is not installed yet.',
        {
          status: 'needs-helper',
          providerId: 'native-helper',
          setupHint,
        },
      );
    }
    return startAndProbe(providers.nativeHelper, 'strategy-native-helper', true);
  }

  if (strategy === 'native-electron-loopback') {
    return startAndProbe(providers.electronLoopback, 'strategy-native-electron-loopback', true);
  }

  let lastError: unknown = null;

  if (strategy === 'auto' && platform === 'macos') {
    if (await isProviderAvailable(providers.coreAudioTap)) {
      try {
        return await startAndProbe(providers.coreAudioTap, 'auto-coreaudio-tap', true);
      } catch (error) {
        lastError = error;
        log('system-audio:provider:failed', {
          ...basePayload,
          providerId: 'coreaudio-tap',
          reason: 'auto-coreaudio-tap',
          error: String(error),
        });
      }
    } else {
      log('system-audio:provider:failed', { ...basePayload, providerId: 'coreaudio-tap', reason: 'helper-unavailable', status: 'needs-helper' });
    }

    try {
      return await tryVirtualInput('auto-virtual-input', lastError);
    } catch (error) {
      lastError = error;
      log('system-audio:provider:failed', {
        ...basePayload,
        providerId: 'virtual-input',
        reason: 'auto-virtual-input',
        error: String(error),
      });
    }

    try {
      return await startAndProbe(providers.electronLoopback, 'auto-native-electron-loopback', true);
    } catch (error) {
      lastError = error;
      log('system-audio:provider:failed', {
        ...basePayload,
        providerId: 'electron-loopback',
        reason: 'auto-native-electron-loopback',
        error: String(error),
        status: error instanceof SystemAudioEngineError ? error.status : 'failed',
      });
    }

    log('system-audio:engine:failed', {
      ...basePayload,
      error: 'Native CoreAudio Tap helper not built and no virtual system input detected.',
      lastError: String(lastError ?? ''),
      status: 'failed',
    });
    throw new SystemAudioEngineError(
      'Native CoreAudio Tap helper not built and no virtual system input detected. Build with npm run build:macos-coreaudio-tap-helper or install BlackHole / VB-CABLE.',
      {
        status: 'failed',
        providerId: null,
        setupHint,
        causeError: lastError,
      },
    );
  }

  if (strategy === 'auto') {
    lastError = null;
    try {
      return await startAndProbe(providers.electronLoopback, 'auto-native-electron-loopback', true);
    } catch (error) {
      lastError = error;
      log('system-audio:provider:failed', {
        ...basePayload,
        providerId: 'electron-loopback',
        reason: 'auto-native-electron-loopback',
        error: String(error),
        status: error instanceof SystemAudioEngineError ? error.status : 'failed',
      });
    }
    return await tryVirtualInput('auto-fallback-virtual-input', lastError);
  }

  throw new SystemAudioEngineError('Unsupported system audio strategy.', { status: 'failed', providerId: null, setupHint });
}
