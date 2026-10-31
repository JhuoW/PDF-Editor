// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ErrorMessage } from '../../src/components/Feedback/ErrorMessage';
import { EditorErrorBoundary } from '../../src/components/Feedback/EditorErrorBoundary';
import { useLocaleStore } from '../../src/i18n/locale';
import { useHistoryStore } from '../../src/store/historyStore';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); useLocaleStore.getState().setLocale('zh-CN');
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useLocaleStore.getState().setLocale('en'); });
it('keeps unknown errors out of the translated summary while preserving exact diagnostic details and copy', async () => {
  const cause = new Error('Unknown font encoding X-987 at object 42'), writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await act(async () => root.render(<ErrorMessage error={cause} operation="Export PDF" />));
  expect(host.querySelector('.diagnostic-summary')!.textContent).not.toContain('Unknown font');
  expect(host.querySelector('code')).toBeNull();
  await act(async () => host.querySelector('button')!.click());
  expect(host.querySelector('code')!.textContent).toBe(cause.message);
  await act(async () => host.querySelector<HTMLButtonElement>('.diagnostic-details button')!.click());
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Operation: Export PDF'));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining(cause.message));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('PDF-Editor: 0.1.0'));
  await act(async () => useLocaleStore.getState().setLocale('en'));
  expect(host.querySelector('code')!.textContent).toBe(cause.message); expect(host.textContent).toContain('Technical details');
});
it('recovers a crashed view without clearing document history', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useHistoryStore.getState().setOriginalDocument(new Uint8Array([42]).buffer, 'original.pdf');
  let crash = true;
  function View() { if (crash) throw new Error('Render failed'); return <div data-testid="recovered" />; }
  await act(async () => root.render(<EditorErrorBoundary><View /></EditorErrorBoundary>));
  expect(host.querySelector('h1')).not.toBeNull();
  crash = false;
  const retry = [...host.querySelectorAll('button')].find(button => button.textContent === '重新显示编辑界面')!;
  await act(async () => retry.click());
  expect(host.querySelector('[data-testid="recovered"]')).not.toBeNull();
  expect(new Uint8Array(useHistoryStore.getState().originalDocument!.data)).toEqual(new Uint8Array([42]));
  useHistoryStore.getState().clearHistory();
});
