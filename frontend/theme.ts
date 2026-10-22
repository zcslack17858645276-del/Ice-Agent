export type Theme = 'light' | 'dark';

const themeKey = 'ice-agent.theme.v1';

export function readTheme(): Theme {
  return localStorage.getItem(themeKey) === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(themeKey, theme);
  applyTheme(theme);
  // Let the other windows (pet / panels) pick the change up immediately.
  window.dispatchEvent(new StorageEvent('storage', { key: themeKey, newValue: theme }));
}
