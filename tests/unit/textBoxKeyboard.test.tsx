// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTextBoxKeyboard } from '../../src/components/TextBox/hooks/useTextBoxKeyboard';
import { useAnnotationStore, createFreeTextAnnotation } from '../../src/store/annotationStore';
import { useTextBoxStore } from '../../src/store/textBoxStore';

let root: Root;
let host: HTMLDivElement;
let annotationId: string;

function KeyboardHost() { useTextBoxKeyboard(); return <input aria-label="Other field" />; }

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useAnnotationStore.setState(useAnnotationStore.getInitialState());
  useTextBoxStore.setState(useTextBoxStore.getInitialState());
  const annotation = createFreeTextAnnotation(1, [10, 20, 200, 60], 'Existing text');
  annotationId = annotation.id;
  useAnnotationStore.getState().addAnnotation(annotation);
  useAnnotationStore.getState().selectAnnotation(annotationId);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<KeyboardHost />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('Enter edits the selected text box using the mounted hook and Escape cancels', async () => {
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })));
  expect(useTextBoxStore.getState().editingTextBoxId).toBe(annotationId);
  expect(useTextBoxStore.getState().cursor.position).toBe('Existing text'.length);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })));
  expect(useTextBoxStore.getState().editingTextBoxId).toBeNull();
});

it('typing into another field does not activate or delete the selected text box', async () => {
  const input = host.querySelector('input')!;
  for (const key of ['Enter', 'Backspace', 'Delete']) {
    const event = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true });
    await act(async () => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  }
  expect(useTextBoxStore.getState().editingTextBoxId).toBeNull();
  expect(useAnnotationStore.getState().getAllAnnotations()).toHaveLength(1);
});
