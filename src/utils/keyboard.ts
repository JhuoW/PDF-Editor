/** Modal dialogs own keyboard input, even when focus is on a button. */
export function hasOpenModal(): boolean {
  return window.document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') !== null;
}

export function isTextInput(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .rich-text-editor, .freetext-editor-container'
  ) !== null;
}

/** Native activation keys belong to focused UI controls rather than the page canvas. */
export function isInteractiveControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(
    'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"]'
  ) !== null;
}
