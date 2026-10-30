// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { t, translateError, translateMessage, useLocaleStore } from '../../src/i18n';
import { en } from '../../src/i18n/en';
import { zhCN } from '../../src/i18n/zh-CN';

afterEach(() => { useLocaleStore.getState().setLocale('en'); localStorage.clear(); });
describe('bilingual UI messages', () => {
  it('has complete Chinese resources and preserves every interpolation token', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(zhCN[key].trim(), key).not.toBe('');
      const slots = (text: string) => [...text.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
      expect(slots(zhCN[key]), key).toEqual(slots(en[key]));
    }
  });
  it('switches immediately, persists preference and leaves interpolated document names intact', () => {
    useLocaleStore.getState().setLocale('zh-CN');
    expect(t('Open')).toBe('打开');
    expect(localStorage.getItem('pdf-editor.locale')).toBe('zh-CN');
    const message = translateMessage('Loading stamp Open Delete.pdf…');
    expect(message).toContain('Open Delete.pdf'); expect(message).not.toContain('Loading');
    useLocaleStore.getState().setLocale('en');
    expect(t('Open')).toBe('Open'); expect(translateMessage('Loading stamp Open Delete.pdf…')).toBe('Loading stamp Open Delete.pdf…');
  });
  it('localizes page history, progress captions and complete image messages', () => {
    useLocaleStore.getState().setLocale('zh-CN');
    expect(translateMessage('Rotate page 1 90°')).not.toMatch(/Rotate|page/);
    expect(translateMessage('Rotate 2 pages 90°')).not.toMatch(/Rotate|pages/);
    expect(translateMessage('Verifying result: 3 / 4')).not.toMatch(/Verifying|result/);
    expect(translateMessage('Rendering 1 of 3 pages')).not.toMatch(/Rendering|pages/);
    expect(translateMessage('Image file is too large (25 MB).\n\nMaximum supported size is 20 MB. Please compress the image and try again.')).not.toMatch(/Maximum|compress|Image file/);
  });
  it('translates nested errors and English-only grammar without losing numbers', () => {
    useLocaleStore.getState().setLocale('zh-CN');
    expect(translateMessage('Loading 2 images…')).not.toMatch(/[A-Za-z]/);
    expect(translateMessage('Loading 2 images…')).toContain('2');
    expect(translateMessage('Failed to export PDF: Could not update PDF text.')).not.toContain('Could not');
    expect(translateError(new Error('Unexpected third party failure'))).not.toContain('Unexpected third party');
    expect(translateMessage(null)).toBe('');
  });
});
