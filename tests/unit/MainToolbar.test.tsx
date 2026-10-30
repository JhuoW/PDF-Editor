// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainToolbar } from '../../src/components/Toolbar/MainToolbar';
import { useLocaleStore } from '../../src/i18n';

type Props = ComponentProps<typeof MainToolbar>;

let container: HTMLDivElement;
let root: Root;
let props: Props;

beforeEach(() => {
  useLocaleStore.getState().setLocale('en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    currentPage: 1,
    totalPages: 120,
    zoom: 1,
    zoomMode: 'manual',
    viewMode: 'single',
    sidebarOpen: true,
    hasDocument: true,
    onOpenFile: vi.fn(),
    onExport: vi.fn(),
    onPreviousPage: vi.fn(),
    onNextPage: vi.fn(),
    onGoToPage: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onSetZoom: vi.fn(),
    onFitToPage: vi.fn(),
    onFitToWidth: vi.fn(),
    onRotate: vi.fn(),
    onToggleSidebar: vi.fn(),
    onSetViewMode: vi.fn(),
    onToggleSearch: vi.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useLocaleStore.getState().setLocale('en');
});

function render(overrides: Partial<Props> = {}) {
  props = { ...props, ...overrides };
  act(() => root.render(<MainToolbar {...props} />));
}

function pageInput() {
  return container.querySelector<HTMLInputElement>('[aria-label="Page number"]')!;
}

function enterPage(value: string) {
  const input = pageInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pressKey(key: string) {
  act(() => {
    pageInput().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('page navigation input', () => {
  it('allows clearing and typing a multi-digit page before navigating on Enter', () => {
    render();
    enterPage('');
    expect(pageInput().value).toBe('');
    enterPage('1');
    enterPage('12');
    expect(props.onGoToPage).not.toHaveBeenCalled();
    pressKey('Enter');
    expect(props.onGoToPage).toHaveBeenCalledExactlyOnceWith(12);
  });

  it('commits a valid page when focus leaves the input', () => {
    render();
    act(() => pageInput().focus());
    enterPage('23');
    act(() => pageInput().blur());
    expect(props.onGoToPage).toHaveBeenCalledExactlyOnceWith(23);
  });

  it.each(['', '0', '-1', '121', '1.5'])('restores the current page for invalid input %j', (value) => {
    render({ currentPage: 8 });
    enterPage(value);
    pressKey('Enter');
    expect(props.onGoToPage).not.toHaveBeenCalled();
    expect(pageInput().value).toBe('8');
  });

  it('cancels a draft with Escape without navigating on subsequent blur', () => {
    render({ currentPage: 8 });
    act(() => pageInput().focus());
    enterPage('23');
    pressKey('Escape');
    act(() => pageInput().blur());
    expect(props.onGoToPage).not.toHaveBeenCalled();
    expect(pageInput().value).toBe('8');
  });

  it('retains unfinished input during unrelated renders and follows external page changes', () => {
    render();
    enterPage('23');
    render({ zoom: 1.25 });
    expect(pageInput().value).toBe('23');
    render({ currentPage: 4 });
    expect(pageInput().value).toBe('4');
    expect(props.onGoToPage).not.toHaveBeenCalled();
  });
});

describe('zoom and toolbar accessibility', () => {
  it('shows the actual manual zoom when it is between presets', () => {
    render({ zoom: 1.5625 });
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Zoom"]')!;
    expect(select.value).toBe('1.5625');
    expect(select.selectedOptions[0].textContent).toBe('156%');
    render({ zoom: 1.25 });
    expect(select.value).toBe('1.25');
    expect(select.querySelector('option[value="1.5625"]')).toBeNull();
  });

  it('preserves fit modes and exposes the active view and sidebar state', () => {
    render({ zoom: 0.873, zoomMode: 'fit-width', viewMode: 'continuous', sidebarOpen: false });
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Zoom"]')!;
    expect(select.value).toBe('fit-width');
    expect(select.selectedOptions[0].textContent).toBe('Fit Width (87%)');
    expect(container.querySelector('[aria-label="Fit to width"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[aria-label="Continuous view"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[aria-label="Single page view"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[aria-label="Toggle sidebar"]')?.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('file actions', () => {
  it('keeps Save, Save as and Export separate and routes each file command to its own callback', () => {
    const onSave = vi.fn(), onSaveAs = vi.fn();
    render({ onSave, onSaveAs });
    const saveButton = container.querySelector<HTMLButtonElement>('.toolbar-save-button')!;
    expect(saveButton.title).toBe('Save PDF (Ctrl+S)');
    act(() => saveButton.click());
    expect(onSave).toHaveBeenCalledOnce(); expect(props.onExport).not.toHaveBeenCalled();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="toolbar-file-actions"]')!;
    act(() => trigger.click());
    act(() => container.querySelector<HTMLButtonElement>('.toolbar-file-actions [data-file-action="save-as"]')!.click());
    expect(onSaveAs).toHaveBeenCalledOnce(); expect(props.onExport).not.toHaveBeenCalled();
    act(() => trigger.click());
    act(() => container.querySelector<HTMLButtonElement>('.toolbar-file-actions [data-file-action="export"]')!.click());
    expect(props.onExport).toHaveBeenCalledOnce(); expect(onSave).toHaveBeenCalledOnce();
  });

  it('opens the native file picker callback while preserving the hidden file input fallback', () => {
    const onOpenFileFromPicker = vi.fn();
    render({ onOpenFileFromPicker });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!, fallback = vi.spyOn(input, 'click');
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Open"]')!.click());
    expect(onOpenFileFromPicker).toHaveBeenCalledOnce(); expect(fallback).not.toHaveBeenCalled();
    render({ onOpenFileFromPicker: undefined });
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Open"]')!.click());
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('disables file mutation actions during saving and displays the chosen filename and unsaved marker', () => {
    render({ onSave: vi.fn(), onSaveAs: vi.fn(), isSaving: true, fileNameOverride: 'saved-copy.pdf', hasUnsavedChanges: true });
    expect(container.querySelector('.document-title')!.textContent).toBe('saved-copy.pdf *');
    expect(container.querySelector<HTMLButtonElement>('.toolbar-save-button')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('.toolbar-btn-primary')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Open"]')!.disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('[aria-controls="toolbar-file-actions"]')!.click());
    expect([...container.querySelectorAll<HTMLButtonElement>('.toolbar-file-save-actions button')].every(button => button.disabled)).toBe(true);
  });

  it('uses natural Chinese Save and Export labels without translating the PDF filename', () => {
    render({ onSave: vi.fn(), onSaveAs: vi.fn(), fileNameOverride: 'English PDF.pdf' });
    act(() => useLocaleStore.getState().setLocale('zh-CN'));
    expect(container.querySelector('.toolbar-btn-primary')!.textContent).toBe('导出');
    expect(container.querySelector('.toolbar-save-button')!.textContent).toBe('保存');
    expect(container.querySelector('.document-title')!.textContent).toBe('English PDF.pdf');
  });

  it('allows creation without an open document and disables page export', () => {
    const onCreatePDF = vi.fn(), onExportPages = vi.fn();
    render({ hasDocument: false, onCreatePDF, onExportPages });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="toolbar-file-actions"]')!;
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const actions = [...container.querySelectorAll<HTMLButtonElement>('.toolbar-file-actions button')];
    expect(document.activeElement).toBe(actions[0]);
    expect(actions[0].disabled).toBe(false);
    expect(actions[1].disabled).toBe(true);
    act(() => actions[0].click());
    expect(onCreatePDF).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.toolbar-file-actions')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('supports keyboard action selection and Escape without invoking an action', () => {
    const onCreatePDF = vi.fn(), onExportPages = vi.fn();
    render({ onCreatePDF, onExportPages });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-controls="toolbar-file-actions"]')!;
    act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    const actions = [...container.querySelectorAll<HTMLButtonElement>('.toolbar-file-actions button')];
    act(() => actions[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(actions[1]);
    act(() => actions[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('.toolbar-file-actions')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onCreatePDF).not.toHaveBeenCalled();
    expect(onExportPages).not.toHaveBeenCalled();
    act(() => trigger.click());
    act(() => container.querySelectorAll<HTMLButtonElement>('.toolbar-file-actions button')[1].click());
    expect(onExportPages).toHaveBeenCalledTimes(1);
  });
});
