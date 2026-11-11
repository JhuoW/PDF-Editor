// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeSwitcher } from '../../src/components/Workspace/ThemeSwitcher';
import { useLocaleStore } from '../../src/i18n';
import { applyThemePreference, THEME_COLORS, THEME_PREFERENCE_KEY, useThemeStore } from '../../src/store/themeStore';

let root: Root, host: HTMLDivElement;
const button = () => host.querySelector<HTMLButtonElement>('.theme-switcher')!;
const themeColors = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(meta => meta.content);

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  document.head.innerHTML = `<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#18191c" media="(prefers-color-scheme: dark)">`;
  useThemeStore.setState({ preference: 'system' });
  applyThemePreference('system');
  useLocaleStore.getState().setLocale('en');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ThemeSwitcher />));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  useThemeStore.setState({ preference: 'system' }); applyThemePreference('system');
  useLocaleStore.getState().setLocale('en'); localStorage.clear(); vi.unstubAllGlobals();
});

describe('appearance switcher', () => {
  it('cycles Follow system, Light and Dark, and remembers a forced choice', async () => {
    expect(button().getAttribute('aria-label')).toBe('Appearance: Follow system. Switch to Light');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(themeColors()).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);

    await act(async () => button().click());
    expect(button().dataset.themePreference).toBe('light');
    expect(button().getAttribute('aria-label')).toBe('Appearance: Light. Switch to Dark');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe('light');
    expect(themeColors()).toEqual([THEME_COLORS.light, THEME_COLORS.light]);

    await act(async () => button().click());
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe('dark');
    expect(themeColors()).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);

    await act(async () => button().click());
    expect(button().dataset.themePreference).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBeNull();
    expect(themeColors()).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);
  });

  it('labels the control in the interface language', async () => {
    await act(async () => useLocaleStore.getState().setLocale('zh-CN'));
    expect(button().getAttribute('aria-label')).toBe('外观：跟随系统。点击切换为浅色');
    expect(button().title).toBe(button().getAttribute('aria-label'));
  });

  it('keeps working when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    try {
      await act(async () => button().click());
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(button().dataset.themePreference).toBe('light');
    } finally { vi.restoreAllMocks(); }
  });
});
