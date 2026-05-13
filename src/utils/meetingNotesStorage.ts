const DASHBOARD_NOTES_KEY = 'openwhispr-dashboard-meeting-notes';
const DASHBOARD_NOTES_V2_KEY = 'openwhispr-dashboard-meeting-notes-v2';

/** Load notes as plain text (joins legacy line arrays with newlines). */
export function loadMeetingNoteText(id: string): string {
  try {
    const raw2 = localStorage.getItem(DASHBOARD_NOTES_V2_KEY);
    if (raw2) {
      const o = JSON.parse(raw2) as Record<string, unknown>;
      const arr = o[id];
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) {
        const lines = arr as string[];
        if (lines.length === 0) return '';
        return lines.join('\n');
      }
    }
    const raw = localStorage.getItem(DASHBOARD_NOTES_KEY);
    if (raw) {
      const o = JSON.parse(raw) as Record<string, string>;
      const t = o[id]?.trim();
      if (t) return t;
    }
  } catch {
    /* ignore */
  }
  return '';
}

/** Persist as v2 string[] (one element per line). */
export function saveMeetingNoteText(id: string, text: string) {
  try {
    const raw = localStorage.getItem(DASHBOARD_NOTES_V2_KEY);
    const o = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    if (!text) {
      o[id] = [];
    } else {
      o[id] = text.split('\n');
    }
    localStorage.setItem(DASHBOARD_NOTES_V2_KEY, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}
