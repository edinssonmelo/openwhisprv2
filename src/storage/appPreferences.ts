export const ONBOARDING_COMPLETED_KEY = 'openwhispr.onboarding.completed.v1';
export const ONBOARDING_SYSTEM_SKIPPED_KEY = 'openwhispr.onboarding.systemSkipped.v1';
export const CAPTURE_PREFERENCE_KEY = 'openwhispr.capturePreference.v1';
export const SYSTEM_CAPTURE_STRATEGY_KEY = 'openwhispr.systemCaptureStrategy.v1';
export const SELECTED_SYSTEM_INPUT_KEY = 'openwhispr.selectedSystemInputId.v1';

export type CapturePreference = 'mic' | 'system' | 'both';
export type SystemCaptureStrategy =
  | 'auto'
  | 'coreaudio-tap'
  | 'native-electron-loopback'
  | 'native-helper'
  | 'virtual-input';

export function isOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markOnboardingComplete(): void {
  try {
    localStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
  } catch {
    /* ignore */
  }
}

export function clearOnboardingComplete(): void {
  try {
    localStorage.removeItem(ONBOARDING_COMPLETED_KEY);
  } catch {
    /* ignore */
  }
}

export function getOnboardingSystemSkipped(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_SYSTEM_SKIPPED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setOnboardingSystemSkipped(value: boolean): void {
  try {
    if (value) localStorage.setItem(ONBOARDING_SYSTEM_SKIPPED_KEY, 'true');
    else localStorage.removeItem(ONBOARDING_SYSTEM_SKIPPED_KEY);
  } catch {
    /* ignore */
  }
}

export function loadCapturePreference(): CapturePreference {
  try {
    const v = localStorage.getItem(CAPTURE_PREFERENCE_KEY);
    if (v === 'mic' || v === 'system' || v === 'both') return v;
  } catch {
    /* ignore */
  }
  return 'both';
}

export function persistCapturePreference(mode: CapturePreference): void {
  try {
    localStorage.setItem(CAPTURE_PREFERENCE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function loadSystemCaptureStrategy(): SystemCaptureStrategy {
  try {
    const v = localStorage.getItem(SYSTEM_CAPTURE_STRATEGY_KEY);
    if (v === 'native-loopback') return 'native-electron-loopback';
    if (
      v === 'auto'
      || v === 'coreaudio-tap'
      || v === 'native-electron-loopback'
      || v === 'native-helper'
      || v === 'virtual-input'
    ) {
      return v;
    }
  } catch {
    /* ignore */
  }
  return 'auto';
}

export function persistSystemCaptureStrategy(strategy: SystemCaptureStrategy): void {
  try {
    localStorage.setItem(SYSTEM_CAPTURE_STRATEGY_KEY, strategy);
  } catch {
    /* ignore */
  }
}

export function loadSelectedSystemInputId(): string {
  try {
    return localStorage.getItem(SELECTED_SYSTEM_INPUT_KEY) ?? '';
  } catch {
    return '';
  }
}

export function persistSelectedSystemInputId(deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(SELECTED_SYSTEM_INPUT_KEY, deviceId);
    else localStorage.removeItem(SELECTED_SYSTEM_INPUT_KEY);
  } catch {
    /* ignore */
  }
}
