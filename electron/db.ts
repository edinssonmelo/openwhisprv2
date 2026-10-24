import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Almacenamiento local real (SQLite) para Openwhispr.
 *
 * Reemplaza el `localStorage` (limitado a ~20 sesiones) usado anteriormente en el renderer.
 * Todo vive en `app.getPath('userData')/openwhispr.db` — nunca se conecta a un servidor remoto.
 *
 * Estrategia de esquema: cada sesión se guarda como JSON en la columna `data` (el tipo
 * `DashboardSessionSummary` sigue evolucionando en el renderer), con columnas indexadas
 * (`id`, `created_at`, `title`) para listar/ordenar sin tener que parsear el JSON.
 */

export type StoredSession = Record<string, unknown> & { id: string };

let db: Database.Database | null = null;

function dbPath(): string {
  return path.join(app.getPath('userData'), 'openwhispr.db');
}

function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run({ key, value });
}

export function listSessions(): StoredSession[] {
  const rows = getDb().prepare('SELECT data FROM sessions ORDER BY created_at DESC').all() as { data: string }[];
  return rows.map((row) => JSON.parse(row.data) as StoredSession);
}

export function upsertSession(session: StoredSession): void {
  if (typeof session.id !== 'string' || !session.id) {
    throw new Error('session.id (string) is required');
  }
  const createdAt = Number(session.createdAt ?? Date.now());
  const title = typeof session.title === 'string' ? session.title : '';
  getDb()
    .prepare(
      `INSERT INTO sessions (id, created_at, updated_at, title, data)
       VALUES (@id, @createdAt, @updatedAt, @title, @data)
       ON CONFLICT(id) DO UPDATE SET
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         title = excluded.title,
         data = excluded.data`,
    )
    .run({
      id: session.id,
      createdAt,
      updatedAt: Date.now(),
      title,
      data: JSON.stringify(session),
    });
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/** Copia las sesiones heredadas de `localStorage` a SQLite una única vez (idempotente). */
export function migrateLegacySessions(sessions: StoredSession[]): { migrated: number } {
  if (getMeta('legacy_sessions_migrated') === 'true') return { migrated: 0 };

  let migrated = 0;
  const insertAll = getDb().transaction((items: StoredSession[]) => {
    for (const session of items) {
      if (typeof session.id !== 'string' || !session.id) continue;
      upsertSession(session);
      migrated += 1;
    }
  });
  insertAll(sessions);
  setMeta('legacy_sessions_migrated', 'true');
  return { migrated };
}

export function registerSessionsIpc(): void {
  ipcMain.handle('db:sessions:list', () => {
    try {
      return { ok: true as const, sessions: listSessions() };
    } catch (error) {
      return { ok: false as const, sessions: [], error: String(error) };
    }
  });

  ipcMain.handle('db:sessions:upsert', (_event, session: unknown) => {
    try {
      upsertSession(session as StoredSession);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  });

  ipcMain.handle('db:sessions:delete', (_event, id: unknown) => {
    try {
      deleteSession(String(id));
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  });

  ipcMain.handle('db:sessions:migrate-legacy', (_event, sessions: unknown) => {
    try {
      const result = migrateLegacySessions(Array.isArray(sessions) ? (sessions as StoredSession[]) : []);
      return { ok: true as const, ...result };
    } catch (error) {
      return { ok: false as const, migrated: 0, error: String(error) };
    }
  });
}
