import { exportPDFPages, type PageExportSettings } from './PageExport';

self.onmessage = async (event: MessageEvent<{ data: ArrayBuffer; settings: PageExportSettings }>) => {
  try {
    const result = await exportPDFPages(event.data.data, event.data.settings, {
      onProgress: progress => self.postMessage({ type: 'progress', progress }),
    });
    self.postMessage({ type: 'result', result }, { transfer: [result.data.buffer] });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not export pages.' });
  }
};
