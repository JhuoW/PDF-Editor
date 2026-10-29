// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeAttributes } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import TipTapEditor, { type TipTapEditorRef } from '../../src/components/TextBox/TipTapEditor';
import { DEFAULT_TEXT_STYLE, type TextStyle } from '../../src/annotations/types';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function mount(defaultStyle: TextStyle = DEFAULT_TEXT_STYLE, initialContent = '<p></p>') {
  const ref = createRef<TipTapEditorRef>();
  await act(async () => { root.render(<TipTapEditor ref={ref} defaultStyle={defaultStyle} initialContent={initialContent} width={300} height={100} autoFocus={false} />); });
  expect(ref.current?.editor).toBeTruthy();
  return ref.current!.editor!;
}
const styleAttributes = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>('[style]')].map(node => node.getAttribute('style')).join(' ');

describe('real rich-text input boundaries', () => {
  it('preserves supported pasted formatting while dropping scripts, event handlers, and unrelated CSS', async () => {
    const editor = await mount();
    await act(async () => { editor.view.pasteHTML(`<p style="text-align:center;position:fixed" onclick="globalThis.injected=true">
      <span style="font-family:Arial;font-size:24px;color:#123456;background-image:url(https://invalid.example/secret)"><strong><u>Safe 中文</u></strong></span>
      <script>globalThis.injected=true</script><img src="x" onerror="globalThis.injected=true">
      <a href="javascript:globalThis.injected=true">link text</a></p><p style="text-align:center">Aligned line</p>`, new Event('paste') as ClipboardEvent); });
    expect(editor.getText()).toContain('Safe 中文');
    expect(editor.getText()).toContain('link text');
    expect(host.querySelector('strong u, u strong')).not.toBeNull();
    expect([...host.querySelectorAll<HTMLElement>('.tiptap p')].some(node => node.style.textAlign === 'center')).toBe(true);
    const span = [...host.querySelectorAll<HTMLSpanElement>('.tiptap span')].find(node => node.style.fontSize === '24px');
    expect(span?.style.fontFamily).toBe('Arial'); expect(span?.style.color).toBe('rgb(18, 52, 86)');
    expect(host.querySelector('script, img, [onclick], [onerror], a[href^="javascript:"]')).toBeNull();
    expect(styleAttributes(host)).not.toMatch(/position|background-image|invalid\.example/);
    expect(editor.getHTML()).not.toContain('globalThis');
  });

  it.each([{ value: 'left;position:fixed;inset:0;background-image:url(https://invalid.example/secret)' }, { value: ['img', { src: 'x', onerror: 'globalThis.injected=true' }] }])('does not render forged clipboard context attributes as styles or DOM: %j', async ({ value }) => {
    const editor = await mount();
    const span = document.createElement('span');
    span.setAttribute('data-pm-slice', `0 0 ${JSON.stringify(['paragraph', { textAlign: value }])}`);
    span.textContent = 'Clipboard content';
    await act(async () => { editor.view.pasteHTML(span.outerHTML, new Event('paste') as ClipboardEvent); });
    expect(editor.getText()).toContain('Clipboard content');
    expect(host.querySelector('img, [onerror]')).toBeNull();
    expect(styleAttributes(host)).not.toMatch(/position|inset|background-image|invalid\.example/);
  });

  it('keeps font-size commands compatible and rejects a value that appends CSS declarations', async () => {
    const editor = await mount(DEFAULT_TEXT_STYLE, '<p>Editable text</p>');
    await act(async () => { editor.chain().selectAll().setFontSize('26px').setFontFamily('Arial').setColor('#123456').toggleUnderline().run(); });
    expect(host.querySelector<HTMLElement>('.tiptap span')?.style.fontSize).toBe('26px');
    expect(host.querySelector('.tiptap u')).not.toBeNull();
    await act(async () => { editor.chain().selectAll().setFontSize('26px;position:fixed;background-image:url(https://invalid.example/secret)').run(); });
    expect(styleAttributes(host)).not.toMatch(/position|background-image|invalid\.example/);
    await act(async () => { editor.commands.unsetFontSize(); });
    expect(editor.getText()).toBe('Editable text');
    expect(editor.getHTML()).not.toContain('font-size');
  });

  it('treats restored default style fields as CSS values rather than complete declarations', async () => {
    await mount({ ...DEFAULT_TEXT_STYLE, fontFamily: 'Arial;position:fixed;inset:0', color: 'red;background-image:url(https://invalid.example/secret)' }, '<p>Restored text</p>');
    expect(host.textContent).toContain('Restored text');
    expect(styleAttributes(host)).not.toMatch(/position|inset|background-image|invalid\.example/);
  });

  it('uses a dependency merge helper that cannot turn a JSON __proto__ key into executable DOM attributes', () => {
    const attributes = mergeAttributes(JSON.parse('{"__proto__":{"onmouseover":"globalThis.injected=true","data-inherited-canary":"present"}}'));
    const { dom } = DOMSerializer.renderSpec(document, ['span', attributes, 'Safe']);
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    expect((dom as HTMLElement).hasAttribute('onmouseover')).toBe(false);
    expect((dom as HTMLElement).hasAttribute('data-inherited-canary')).toBe(false);
    expect(dom.textContent).toBe('Safe');
  });
});
