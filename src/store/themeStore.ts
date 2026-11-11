import { create } from 'zustand';

/** "system" follows the operating system through CSS prefers-color-scheme. */
export type ThemePreference = 'system' | 'light' | 'dark';
export const THEME_PREFERENCE_KEY = 'pdf-editor.theme';
/** Browser UI color behind the app header for each scheme (see index.html). */
export const THEME_COLORS = { light: '#ffffff', dark: '#18191c' } as const;

function savedPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_PREFERENCE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Preferences are optional when browser storage is unavailable. */ }
  return 'system';
}

/**
 * Apply a preference to the document. index.html runs the same logic before the
 * first paint so a forced theme never flashes the other one while loading.
 */
export function applyThemePreference(preference: ThemePreference) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = preference === 'system' ? (meta.getAttribute('media')?.includes('dark') ? 'dark' : 'light') : preference;
    meta.content = THEME_COLORS[scheme];
  }
}

export const useThemeStore = create<{ preference: ThemePreference; setPreference: (preference: ThemePreference) => void }>(set => ({
  preference: savedPreference(),
  setPreference: preference => {
    try {
      if (preference === 'system') localStorage.removeItem(THEME_PREFERENCE_KEY);
      else localStorage.setItem(THEME_PREFERENCE_KEY, preference);
    } catch { /* Keep the current session usable. */ }
    applyThemePreference(preference);
    set({ preference });
  },
}));

applyThemePreference(useThemeStore.getState().preference);
