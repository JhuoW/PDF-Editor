import { inspectPDFOptimization, optimizePDF } from './PDFOptimizer';
import { DEFAULT_OPTIMIZER_SETTINGS, type OptimizerProgress, type OptimizerSettings } from './PDFOptimizerTypes';

self.onmessage = async (event: MessageEvent<{ job: 'inspect' | 'optimize'; data: ArrayBuffer; settings?: OptimizerSettings }>) => {
  try {
    const { job, data, settings } = event.data;
    if (job !== 'inspect' && job !== 'optimize') throw new Error('Unknown PDF compression operation.');
    if (!(data instanceof ArrayBuffer)) throw new Error('The PDF compression worker received invalid document data.');
    const control = { onProgress: (progress: OptimizerProgress) => self.postMessage({ type: 'progress', progress }) };
    const result = job === 'inspect' ? await inspectPDFOptimization(data, control) : await optimizePDF(data, settings ?? DEFAULT_OPTIMIZER_SETTINGS, control);
    self.postMessage({ type: 'result', result }, { transfer: 'data' in result ? [result.data.buffer] : [] });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not compress the PDF.' });
  }
};
