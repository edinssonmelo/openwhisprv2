import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';

/**
 * Actualizaciones automáticas / semi-automáticas para Openwhispr.
 *
 * - Publica releases en GitHub Releases (ver electron-builder `publish` en package.json).
 * - Al abrir la app (empaquetada) se comprueba el canal correspondiente.
 * - La UI puede lanzar "Buscar actualizaciones" vía IPC `updates:check`.
 * - Los estados se emiten al renderer por `updates:status`.
 *
 * Canales:
 * - `latest`  -> versiones estables (ej. v0.1.0)
 * - `beta`    -> prereleases (ej. v0.2.0-beta.1). Se activa si la versión instalada es prerelease.
 *
 * Nota MVP: en macOS la instalación automática requiere firma + notarización de Apple.
 * Sin firma, la comprobación funciona pero la descarga/instalación puede fallar; en ese caso
 * se emite estado `error` y el usuario puede descargar manualmente desde la landing.
 */

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

let configured = false;
let lastStatus: UpdateStatus = { state: 'idle' };

function sendStatus(getWindow: () => BrowserWindow | null, status: UpdateStatus) {
  lastStatus = status;
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updates:status', status);
  }
  log.info('[updater] status', status);
}

function isPrereleaseVersion(version: string): boolean {
  return /-(?:alpha|beta|rc)\b/i.test(version);
}

/**
 * Inicializa el auto-updater y registra los IPC handlers.
 * Seguro de llamar en dev: no hace nada de red si la app no está empaquetada.
 */
export function initUpdater(getWindow: () => BrowserWindow | null): void {
  if (configured) return;
  configured = true;

  // Self-hosted beta uses the verified landing download until a signed update feed exists.
  const hasUpdateFeed = app.isPackaged && existsSync(path.join(process.resourcesPath, 'app-update.yml'));

  log.transports.file.level = 'info';
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Recibe prereleases (beta) solo si la versión instalada ya es prerelease.
  autoUpdater.allowPrerelease = isPrereleaseVersion(app.getVersion());
  autoUpdater.channel = autoUpdater.allowPrerelease ? 'beta' : 'latest';

  autoUpdater.on('checking-for-update', () => sendStatus(getWindow, { state: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    sendStatus(getWindow, { state: 'available', version: info.version }),
  );
  autoUpdater.on('update-not-available', (info) =>
    sendStatus(getWindow, { state: 'not-available', version: info.version }),
  );
  autoUpdater.on('download-progress', (p) =>
    sendStatus(getWindow, { state: 'downloading', percent: Math.round(p.percent) }),
  );
  autoUpdater.on('update-downloaded', (info) =>
    sendStatus(getWindow, { state: 'ready', version: info.version }),
  );
  autoUpdater.on('error', (err) =>
    sendStatus(getWindow, { state: 'error', message: err?.message ?? String(err) }),
  );

  ipcMain.handle('updates:get-status', () => lastStatus);

  ipcMain.handle('updates:check', async () => {
    if (!hasUpdateFeed) {
      return { ok: false, reason: 'manual-download' as const };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true as const };
    } catch (error) {
      sendStatus(getWindow, { state: 'error', message: String(error) });
      return { ok: false, reason: 'error' as const, message: String(error) };
    }
  });

  ipcMain.handle('updates:quit-and-install', () => {
    if (lastStatus.state !== 'ready') return { ok: false as const };
    autoUpdater.quitAndInstall();
    return { ok: true as const };
  });

  // Comprobación silenciosa al arrancar (solo empaquetada).
  if (hasUpdateFeed) {
    autoUpdater.checkForUpdates().catch((error) => {
      sendStatus(getWindow, { state: 'error', message: String(error) });
    });
  }
}
