export const ONBOARDING_COMPLETED_KEY = 'openwhispr.onboarding.completed.v1';
export const ONBOARDING_SYSTEM_SKIPPED_KEY = 'openwhispr.onboarding.systemSkipped.v1';
export const CAPTURE_PREFERENCE_KEY = 'openwhispr.capturePreference.v1';
export const SYSTEM_CAPTURE_STRATEGY_KEY = 'openwhispr.systemCaptureStrategy.v1';
export const SELECTED_SYSTEM_INPUT_KEY = 'openwhispr.selectedSystemInputId.v1';
export const PERMISSION_RECORD_KEY = 'openwhispr.permissionRecord.v1';
export const USER_PROFILE_KEY = 'openwhispr.userProfile.v1';
export const PROMPT_PROFILES_KEY = 'openwhispr.promptProfiles.v1';
export const SELECTED_PROMPT_PROFILE_KEY = 'openwhispr.selectedPromptProfileId.v1';
export const APP_LANGUAGE_KEY = 'openwhispr.appLanguage.v1';
export const CONTEXT_SPACES_KEY = 'openwhispr.contextSpaces.v1';

export type CapturePreference = 'mic' | 'system' | 'both';
export type SystemCaptureStrategy =
  | 'auto'
  | 'coreaudio-tap'
  | 'native-electron-loopback'
  | 'native-helper'
  | 'virtual-input';
export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';
export type AppLanguage = 'es' | 'en';

export interface PermissionRecord {
  microphone: PermissionState;
  systemAudio: PermissionState;
  screenCapture: PermissionState;
  checkedAt: number;
}

export interface UserProfile {
  name: string;
  role?: string;
  organization?: string;
  email?: string;
  updatedAt: number;
}

export interface PromptProfile {
  id: string;
  name: string;
  scope: 'meeting-assistant' | 'general-context';
  systemPrompt: string;
  contextPrompt: string;
  isDefault?: boolean;
  updatedAt: number;
}

export interface ContextSpace {
  id: string;
  name: string;
  description?: string;
  sessionIds: string[];
  isDefault?: boolean;
  updatedAt: number;
}

export const DEFAULT_USER_PROFILE: UserProfile = {
  name: 'Michael',
  updatedAt: 0,
};

export const DEFAULT_PROMPT_PROFILE: PromptProfile = {
  id: 'meeting-assistant-default',
  name: 'Meeting assistant',
  scope: 'meeting-assistant',
  isDefault: true,
  updatedAt: 0,
  systemPrompt: 'Eres un asistente local para reuniones. Ayuda con respuestas breves y utiles usando la transcripcion disponible, el contexto de la reunion y las notas relacionadas. No inventes datos; si falta contexto, pide una aclaracion.',
  contextPrompt: 'Si la pregunta se refiere a lo ultimo, prioriza los minutos recientes de la transcripcion. Si la pregunta es general, usa todo el contexto disponible de la reunion y las reuniones relacionadas seleccionadas.',
};

export const DEFAULT_CONTEXT_SPACE: ContextSpace = {
  id: 'general',
  name: 'General',
  description: 'Reuniones sin un contexto especifico.',
  sessionIds: [],
  isDefault: true,
  updatedAt: 0,
};

const DEFAULT_PERMISSION_RECORD: PermissionRecord = {
  microphone: 'unknown',
  systemAudio: 'unknown',
  screenCapture: 'unknown',
  checkedAt: 0,
};

function readJson<T>(key: string, fallback: T, guard: (value: unknown) => value is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return guard(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function isPermissionState(value: unknown): value is PermissionState {
  return value === 'granted' || value === 'denied' || value === 'prompt' || value === 'unknown';
}

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

export function loadPermissionRecord(): PermissionRecord {
  return readJson(PERMISSION_RECORD_KEY, DEFAULT_PERMISSION_RECORD, (value): value is PermissionRecord => {
    if (!value || typeof value !== 'object') return false;
    const r = value as Partial<PermissionRecord>;
    return isPermissionState(r.microphone) && isPermissionState(r.systemAudio) && isPermissionState(r.screenCapture);
  });
}

export function persistPermissionRecord(record: Partial<PermissionRecord>): PermissionRecord {
  const next = { ...loadPermissionRecord(), ...record, checkedAt: Date.now() };
  writeJson(PERMISSION_RECORD_KEY, next);
  return next;
}

export function loadUserProfile(): UserProfile {
  return readJson(USER_PROFILE_KEY, DEFAULT_USER_PROFILE, (value): value is UserProfile => {
    if (!value || typeof value !== 'object') return false;
    const p = value as Partial<UserProfile>;
    return typeof p.name === 'string' && p.name.trim().length > 0;
  });
}

export function persistUserProfile(profile: UserProfile): void {
  writeJson(USER_PROFILE_KEY, { ...profile, name: profile.name.trim() || DEFAULT_USER_PROFILE.name, updatedAt: Date.now() });
}

export function loadPromptProfiles(): PromptProfile[] {
  const profiles = readJson(PROMPT_PROFILES_KEY, [DEFAULT_PROMPT_PROFILE], (value): value is PromptProfile[] => {
    return Array.isArray(value) && value.every((profile) => (
      profile && typeof profile === 'object' &&
      typeof (profile as Partial<PromptProfile>).id === 'string' &&
      typeof (profile as Partial<PromptProfile>).name === 'string' &&
      typeof (profile as Partial<PromptProfile>).systemPrompt === 'string' &&
      typeof (profile as Partial<PromptProfile>).contextPrompt === 'string'
    ));
  });
  return profiles.some((profile) => profile.id === DEFAULT_PROMPT_PROFILE.id) ? profiles : [DEFAULT_PROMPT_PROFILE, ...profiles];
}

export function persistPromptProfiles(profiles: PromptProfile[]): void {
  const normalized = profiles.length > 0 ? profiles : [DEFAULT_PROMPT_PROFILE];
  writeJson(PROMPT_PROFILES_KEY, normalized.map((profile) => ({ ...profile, updatedAt: profile.updatedAt || Date.now() })));
}

export function loadSelectedPromptProfileId(): string {
  try {
    return localStorage.getItem(SELECTED_PROMPT_PROFILE_KEY) || DEFAULT_PROMPT_PROFILE.id;
  } catch {
    return DEFAULT_PROMPT_PROFILE.id;
  }
}

export function persistSelectedPromptProfileId(id: string): void {
  try {
    localStorage.setItem(SELECTED_PROMPT_PROFILE_KEY, id || DEFAULT_PROMPT_PROFILE.id);
  } catch {
    /* ignore */
  }
}

export function loadAppLanguage(): AppLanguage {
  try {
    const value = localStorage.getItem(APP_LANGUAGE_KEY);
    if (value === 'es' || value === 'en') return value;
  } catch {
    /* ignore */
  }
  return 'es';
}

export function persistAppLanguage(language: AppLanguage): void {
  try {
    localStorage.setItem(APP_LANGUAGE_KEY, language);
  } catch {
    /* ignore */
  }
}

function normalizeContextSpaces(spaces: ContextSpace[]): ContextSpace[] {
  const seen = new Set<string>();
  const normalized = spaces
    .filter((space) => space && typeof space.id === 'string' && typeof space.name === 'string')
    .map((space) => {
      const id = space.id.trim() || `context-${Date.now()}`;
      const sessionIds = Array.from(new Set((space.sessionIds ?? []).filter((sessionId) => typeof sessionId === 'string' && sessionId.trim())));
      return {
        ...space,
        id,
        name: space.name.trim() || 'Untitled context',
        sessionIds,
        updatedAt: space.updatedAt || Date.now(),
      };
    })
    .filter((space) => {
      if (seen.has(space.id)) return false;
      seen.add(space.id);
      return true;
    });
  return normalized.some((space) => space.id === DEFAULT_CONTEXT_SPACE.id)
    ? normalized.map((space) => space.id === DEFAULT_CONTEXT_SPACE.id ? { ...DEFAULT_CONTEXT_SPACE, ...space, isDefault: true } : space)
    : [DEFAULT_CONTEXT_SPACE, ...normalized];
}

export function loadContextSpaces(): ContextSpace[] {
  const spaces = readJson(CONTEXT_SPACES_KEY, [DEFAULT_CONTEXT_SPACE], (value): value is ContextSpace[] => {
    return Array.isArray(value) && value.every((space) => (
      space && typeof space === 'object' &&
      typeof (space as Partial<ContextSpace>).id === 'string' &&
      typeof (space as Partial<ContextSpace>).name === 'string' &&
      Array.isArray((space as Partial<ContextSpace>).sessionIds)
    ));
  });
  return normalizeContextSpaces(spaces);
}

export function persistContextSpaces(spaces: ContextSpace[]): void {
  writeJson(CONTEXT_SPACES_KEY, normalizeContextSpaces(spaces));
}
