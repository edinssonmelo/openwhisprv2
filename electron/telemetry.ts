import { app, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Telemetría mínima, anónima y opt-in + envío de feedback para Openwhispr.
 *
 * Principios (local-first):
 * - NUNCA se envía audio ni transcripciones.
 * - NUNCA se envían datos personales sensibles.
 * - La telemetría es OPT-IN: sin consentimiento no se envía nada.
 * - El usuario puede desactivarla en cualquier momento.
 *
 * Datos que se guardan LOCALMENTE (userData/telemetry.json):
 * - installId anónimo (UUID)
 * - consentimiento (boolean)
 *
 * Eventos remotos (solo con consentimiento) al `OPENWHISPR_TELEMETRY_ENDPOINT`:
 * - installId, event, os, appVersion, timestamp.
 *
 * Feedback (voluntario) al `OPENWHISPR_FEEDBACK_ENDPOINT`:
 * - message, email (opcional), os, appVersion, installId, includeLogs (opt-in).
 */

const TELEMETRY_ENDPOINT = process.env.OPENWHISPR_TELEMETRY_ENDPOINT?.trim() || '';
const FEEDBACK_ENDPOINT = process.env.OPENWHISPR_FEEDBACK_ENDPOINT?.trim() || '';
const FEEDBACK_URL = process.env.OPENWHISPR_FEEDBACK_URL?.trim() || '';

interface TelemetryState {
  installId: string;
  consent: boolean;
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'telemetry.json');
}

function loadState(): TelemetryState {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<TelemetryState>;
    if (parsed.installId) {
      return { installId: parsed.installId, consent: Boolean(parsed.consent) };
    }
  } catch {
    // primer arranque o archivo corrupto: se regenera
  }
  const fresh: TelemetryState = { installId: randomUUID(), consent: false };
  saveState(fresh);
  return fresh;
}

function saveState(state: TelemetryState): void {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // sin persistencia: se mantiene solo en memoria durante la sesión
  }
}

let state: TelemetryState | null = null;

function getState(): TelemetryState {
  if (!state) state = loadState();
  return state;
}

function osInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    release: process.getSystemVersion?.() ?? '',
  };
}

async function post(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Envía un evento anónimo solo si hay consentimiento y endpoint configurado. */
async function track(event: string, props?: Record<string, unknown>): Promise<void> {
  const s = getState();
  if (!s.consent || !TELEMETRY_ENDPOINT) return;
  await post(TELEMETRY_ENDPOINT, {
    installId: s.installId,
    event,
    props: props ?? {},
    os: osInfo(),
    appVersion: app.getVersion(),
    timestamp: new Date().toISOString(),
  });
}

export function registerTelemetryIpc(): void {
  // Evento de apertura de app (solo si ya hay consentimiento previo).
  void track('app_open');

  ipcMain.handle('telemetry:get-consent', () => ({
    consent: getState().consent,
    installId: getState().installId,
    endpointConfigured: Boolean(TELEMETRY_ENDPOINT),
  }));

  ipcMain.handle('telemetry:set-consent', (_event, consent: unknown) => {
    const next = Boolean(consent);
    state = { ...getState(), consent: next };
    saveState(state);
    if (next) void track('telemetry_opt_in');
    return { ok: true, consent: next };
  });

  ipcMain.handle('telemetry:track', (_event, event: unknown, props: unknown) => {
    if (typeof event !== 'string') return { ok: false };
    void track(event, (props as Record<string, unknown>) ?? undefined);
    return { ok: true };
  });

  ipcMain.handle('telemetry:get-install-id', () => getState().installId);

  ipcMain.handle(
    'feedback:submit',
    async (
      _event,
      payload: { message?: string; email?: string; includeLogs?: boolean } | undefined,
    ) => {
      const message = payload?.message?.trim();
      if (!message) return { ok: false, reason: 'empty' as const };

      if (!FEEDBACK_ENDPOINT) {
        return { ok: false, reason: 'no-endpoint' as const };
      }

      const body = {
        message,
        email: payload?.email?.trim() || null,
        os: osInfo(),
        appVersion: app.getVersion(),
        installId: getState().installId,
        includeLogs: Boolean(payload?.includeLogs),
        timestamp: new Date().toISOString(),
      };
      const ok = await post(FEEDBACK_ENDPOINT, body);
      return ok ? { ok: true as const } : { ok: false as const, reason: 'network' as const };
    },
  );

  /** Abre el formulario de feedback web (fallback cuando no hay endpoint propio). */
  ipcMain.handle('feedback:open-external', async () => {
    const url =
      FEEDBACK_URL ||
      `https://github.com/openwhispr/openwhispr/issues/new?labels=feedback&template=feedback.md`;
    await shell.openExternal(url);
    return { ok: true };
  });
}
