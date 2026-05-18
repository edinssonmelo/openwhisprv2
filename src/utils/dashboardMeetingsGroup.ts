import type { DashboardSessionSummary } from '../types/dashboardSession';

export type DashboardDayGroup = {
  dayKey: string;
  label: string;
  sessions: DashboardSessionSummary[];
};

function localDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDayHeading(ts: number): string {
  return new Intl.DateTimeFormat('es', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(ts));
}

/** Sessions must be pre-sorted by `createdAt` descending (newest first). */
export function groupDashboardSessionsByDay(sortedNewestFirst: DashboardSessionSummary[]): DashboardDayGroup[] {
  const out: DashboardDayGroup[] = [];
  for (const s of sortedNewestFirst) {
    const key = localDayKey(s.createdAt);
    const last = out[out.length - 1];
    if (last && last.dayKey === key) {
      last.sessions.push(s);
    } else {
      out.push({
        dayKey: key,
        label: formatDayHeading(s.createdAt),
        sessions: [s],
      });
    }
  }
  return out;
}
