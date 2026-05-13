export const DASHBOARD_THEME_STORAGE_KEY = 'openwhispr.dashboard.theme.v1';

export type DashboardTheme = 'light' | 'dark';

export function readDashboardTheme(): DashboardTheme {
  try {
    const v = localStorage.getItem(DASHBOARD_THEME_STORAGE_KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    /* ignore */
  }
  return 'light';
}

export function writeDashboardTheme(theme: DashboardTheme): void {
  try {
    localStorage.setItem(DASHBOARD_THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}
