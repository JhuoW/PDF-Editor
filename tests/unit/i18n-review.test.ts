// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { t, translateError, translateMessage, useLocaleStore } from '../../src/i18n';

afterEach(() => { useLocaleStore.getState().setLocale('en'); localStorage.clear(); });

describe('translation boundary regressions', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('treats %s as an unknown message instead of reading Object.prototype', source => {
    expect(t(source)).toBe(source);
    useLocaleStore.getState().setLocale('zh-CN');
    expect(t(source)).toBe(source);
    expect(translateMessage(source)).toBe(source);
    expect(translateError(new Error(source))).not.toBe(source);
  });
  it('does not interpolate inherited parameter properties', () => {
    const values = Object.create({ v0: 'Hidden prototype value' });
    expect(t('Loading stamp {v0}…', values)).toBe('Loading stamp {v0}…');
  });
  it('keeps cleanup progress and complete validation errors localizable in either direction', () => {
    useLocaleStore.getState().setLocale('zh-CN');
    for (const phase of ['Checking document', 'Removing selected items', 'Verifying cleanup', 'Rewriting PDF']) {
      const source = `${phase}: 3 / 10`, localized = translateMessage(source);
      expect(localized).not.toContain(phase);
      expect(localized).toContain('3 / 10');
    }
    expect(translateError('Invalid page range.')).not.toContain('Invalid');
    useLocaleStore.getState().setLocale('en');
    expect(translateMessage('Checking document: 3 / 10')).toBe('Checking document: 3 / 10');
  });
});
