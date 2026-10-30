import { create } from 'zustand';

export type Locale = 'en' | 'zh-CN';
const PREFERENCE_KEY = 'pdf-editor.locale';
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(PREFERENCE_KEY);
    if (saved === 'en' || saved === 'zh-CN') return saved;
  } catch { /* Preferences are optional when browser storage is unavailable. */ }
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
export const useLocaleStore = create<{ locale: Locale; setLocale: (locale: Locale) => void }>(set => ({
  locale: initialLocale(),
  setLocale: locale => {
    try { localStorage.setItem(PREFERENCE_KEY, locale); } catch { /* Keep the current session usable. */ }
    set({ locale });
  },
}));
export const useLocale = () => useLocaleStore(state => state.locale);
