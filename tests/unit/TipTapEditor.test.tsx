// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TipTapEditor from '../../src/components/TextBox/TipTapEditor';
import { DEFAULT_TEXT_STYLE } from '../../src/annotations/types';

const { callbacks } = vi.hoisted(() => ({ callbacks: { current: {} as { onBlur: () => void; onFocus: () => void } } }));
vi.mock('@tiptap/react', () => ({
  useEditor: (options: typeof callbacks.current) => { callbacks.current = options; return null; },
  EditorContent: () => null,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
function render(onBlur: () => void) {
  act(() => root.render(<TipTapEditor defaultStyle={DEFAULT_TEXT_STYLE} width={200} height={80} onBlur={onBlur} />));
}
describe('text editor deferred blur', () => {
  it('commits only once when multiple blur notifications arrive', () => {
    const onBlur = vi.fn();
    render(onBlur);
    callbacks.current.onBlur();
    vi.advanceTimersByTime(50);
    callbacks.current.onBlur();
    vi.advanceTimersByTime(50);
    expect(onBlur).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
  it('cancels pending blur when focus returns or the editor unmounts', () => {
    const onBlur = vi.fn();
    render(onBlur);
    callbacks.current.onBlur();
    callbacks.current.onFocus();
    vi.advanceTimersByTime(200);
    expect(onBlur).not.toHaveBeenCalled();
    callbacks.current.onBlur();
    act(() => root.render(null));
    vi.advanceTimersByTime(200);
    expect(onBlur).not.toHaveBeenCalled();
  });
  it('reads the latest commit callback instead of a stale empty draft', () => {
    const initial = vi.fn(), latest = vi.fn();
    render(initial);
    callbacks.current.onBlur();
    render(latest);
    vi.advanceTimersByTime(100);
    expect(initial).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});
