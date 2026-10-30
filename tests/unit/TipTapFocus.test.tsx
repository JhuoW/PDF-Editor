// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TipTapEditor, { type TipTapEditorRef } from '../../src/components/TextBox/TipTapEditor';
import { DEFAULT_TEXT_STYLE } from '../../src/annotations/types';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); vi.runOnlyPendingTimers();
  host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});
function mount() {
  const ref = createRef<TipTapEditorRef>();
  act(() => root.render(<TipTapEditor ref={ref} defaultStyle={DEFAULT_TEXT_STYLE} initialContent="<p>Original text</p>" width={300} height={100} />));
  return ref.current!.editor!;
}

it('keeps a user selection made before deferred editor initialization and replaces the selected text', () => {
  const editor = mount();
  act(() => { editor.commands.selectAll(); editor.view.focus(); });
  const selection = editor.state.selection;
  act(() => vi.runOnlyPendingTimers());
  expect(editor.state.selection.eq(selection)).toBe(true);
  act(() => { editor.commands.insertContent('Replacement'); });
  expect(editor.getText()).toBe('Replacement');
});

it('focuses an untouched new editing session at the end of its existing text', () => {
  const editor = mount();
  act(() => vi.runOnlyPendingTimers());
  expect(editor.view.hasFocus()).toBe(true);
  act(() => { editor.commands.insertContent(' appended'); });
  expect(editor.getText()).toBe('Original text appended');
});
