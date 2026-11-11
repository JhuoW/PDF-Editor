import { create } from 'zustand';

/** In-app replacements for window.alert/confirm/prompt: styled, localized and never blocked by the browser. */
export interface AppDialogOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}
export type AppDialogKind = 'confirm' | 'alert' | 'prompt';
export interface AppDialogRequest extends AppDialogOptions {
  id: number;
  kind: AppDialogKind;
  defaultValue?: string;
  resolve: (value: boolean | string | null | undefined) => void;
}
interface AppDialogState {
  queue: AppDialogRequest[];
  /** A short, non-blocking confirmation shown in the status bar. */
  notice: { id: number; message: string } | null;
}

export const useAppDialogStore = create<AppDialogState>(() => ({ queue: [], notice: null }));
let nextId = 0;

function enqueue<T>(request: Omit<AppDialogRequest, 'id' | 'resolve'>) {
  return new Promise<T>(resolve => {
    useAppDialogStore.setState(state => ({ queue: [...state.queue, { ...request, id: ++nextId, resolve: resolve as AppDialogRequest['resolve'] }] }));
  });
}

export const appConfirm = (options: AppDialogOptions) => enqueue<boolean>({ kind: 'confirm', ...options });
export const appAlert = (message: string, options: Omit<AppDialogOptions, 'message'> = {}) => enqueue<void>({ kind: 'alert', message, ...options });
export const appPrompt = (options: AppDialogOptions & { defaultValue?: string }) => enqueue<string | null>({ kind: 'prompt', ...options });

/** Settles one request; cancel results are false (confirm), null (prompt) or undefined (alert). */
export function settleAppDialog(id: number, value: boolean | string | null | undefined) {
  const request = useAppDialogStore.getState().queue.find(item => item.id === id);
  if (!request) return;
  useAppDialogStore.setState(state => ({ queue: state.queue.filter(item => item.id !== id) }));
  request.resolve(value);
}

export function showAppNotice(message: string) {
  useAppDialogStore.setState({ notice: { id: ++nextId, message } });
}
export function clearAppNotice(id: number) {
  if (useAppDialogStore.getState().notice?.id === id) useAppDialogStore.setState({ notice: null });
}
