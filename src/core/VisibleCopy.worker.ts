import { createVisibleCopy, inspectVisibleCopy } from './VisibleCopy';
import type { VisibleCopySettings } from './VisibleCopyTypes';

self.onmessage = async (event: MessageEvent<{ job: 'inspect' | 'create'; data: ArrayBuffer; settings: VisibleCopySettings; previewPage?: number }>) => {
  try {
    const { job, data, settings, previewPage } = event.data;
    if (job !== 'inspect' && job !== 'create') throw new Error('Unknown visible-copy operation.');
    const control = { previewPage, onProgress: (progress: unknown) => self.postMessage({ type: 'progress', progress }) };
    const result = job === 'inspect' ? await inspectVisibleCopy(data, settings, control) : await createVisibleCopy(data, settings, control);
    self.postMessage({ type: 'result', result }, { transfer: 'data' in result ? [result.data.buffer] : [] });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not create a visible copy.' });
  }
};
