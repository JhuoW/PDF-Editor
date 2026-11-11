import { Monitor, Moon, Sun } from 'lucide-react';
import { t, useLocale } from '../../i18n';
import { useThemeStore, type ThemePreference } from '../../store/themeStore';

const ORDER: readonly ThemePreference[] = ['system', 'light', 'dark'];
const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
const LABELS = { system: 'theme.system', light: 'theme.light', dark: 'theme.dark' } as const;

/** One header button that cycles Follow system → Light → Dark. */
export function ThemeSwitcher() {
  useLocale();
  const preference = useThemeStore(state => state.preference), setPreference = useThemeStore(state => state.setPreference);
  const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length], Icon = ICONS[preference];
  const label = t('theme.switch', { v0: t(LABELS[preference]), v1: t(LABELS[next]) });
  return <button type="button" className="toolbar-btn icon-only theme-switcher" data-theme-preference={preference} aria-label={label} title={label}
    onPointerDown={event => event.preventDefault()} onClick={() => setPreference(next)}>
    <Icon size={18} aria-hidden="true" />
  </button>;
}
