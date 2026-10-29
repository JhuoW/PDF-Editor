import type { Page as RecognizedPage } from 'tesseract.js';
import type { OCRLanguage } from './types';
import { abortError, checkAborted } from './types';

interface WorkerProgress { status: string; progress: number }
interface PendingJob { action: string; resolve: (data: unknown) => void; reject: (error: Error) => void }

/**
 * Adapter for the bundled Tesseract.js 6.0.1 worker protocol. Keep this version
 * in sync with the locally packaged worker; upgrades require the real browser
 * OCR tests. Unlike createWorker(), this owns the worker during initialization,
 * so cancellation and initialization failures cannot leave a live orphan worker.
 * The Chinese-first `chi_sim+eng` order is intentional. In our real bilingual
 * browser fixture 6.0.1 recognizes both scripts, while 7.0.0 turns the Chinese
 * line into Latin characters with every SIMD variant. Do not upgrade or reorder
 * languages without retaining the Chinese production-browser regression test.
 */
export class LocalOCRWorker {
  private readonly worker: Worker;
  private readonly workerId = `pdf-ocr-${crypto.randomUUID()}`;
  private readonly pending = new Map<string, PendingJob>();
  private readonly signal?: AbortSignal;
  private readonly onProgress?: (progress: WorkerProgress) => void;
  private failure: Error | null = null;
  private closed = false;

  constructor(signal?: AbortSignal, onProgress?: (progress: WorkerProgress) => void) {
    checkAborted(signal);
    const assets = new URL(`${import.meta.env.BASE_URL}ocr/`, window.document.baseURI);
    this.worker = new Worker(new URL('worker.min.js', assets));
    this.signal = signal;
    this.onProgress = onProgress;
    signal?.addEventListener('abort', this.onAbort, { once: true });
    this.worker.onerror = event => {
      event.preventDefault();
      this.fail(new Error(event.message || 'The local OCR worker failed.'));
    };
    this.worker.onmessageerror = () => this.fail(new Error('The local OCR worker returned unreadable data.'));
    this.worker.onmessage = event => {
      if (this.closed) return;
      const packet = event.data;
      if (!packet || typeof packet !== 'object' || packet.workerId !== this.workerId
        || typeof packet.jobId !== 'string' || typeof packet.action !== 'string'
        || !['resolve', 'reject', 'progress'].includes(packet.status)) {
        this.fail(new Error('The local OCR worker returned an invalid response.'));
        return;
      }
      const job = this.pending.get(packet.jobId);
      if (!job || job.action !== packet.action) {
        this.fail(new Error('The local OCR worker returned an unexpected job response.'));
        return;
      }
      if (packet.status === 'progress') {
        const { status, progress } = packet.data ?? {};
        if (typeof status !== 'string' || !Number.isFinite(progress)) {
          this.fail(new Error('The local OCR worker returned invalid progress.'));
          return;
        }
        try { this.onProgress?.({ status, progress: Math.max(0, Math.min(1, progress)) }); }
        catch (cause) { this.fail(new Error('Could not report OCR progress.', { cause })); }
      } else if (packet.status === 'reject') {
        this.fail(new Error(`OCR failed: ${typeof packet.data === 'string' ? packet.data : 'worker error'}`));
      } else {
        this.pending.delete(packet.jobId);
        job.resolve(packet.data);
      }
    };
  }

  private readonly onAbort = () => this.fail(abortError());

  private fail(error: Error) {
    if (this.closed) return;
    this.failure = error;
    this.terminate();
  }

  private run(action: string, payload: unknown, transfer: Transferable[] = []) {
    checkAborted(this.signal);
    if (this.closed) return Promise.reject(this.failure ?? new Error('The OCR worker has been closed.'));
    const jobId = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(jobId, { action, resolve, reject });
      try { this.worker.postMessage({ workerId: this.workerId, jobId, action, payload }, transfer); }
      catch (cause) { this.fail(new Error('Could not send the page to the OCR worker.', { cause })); }
    });
  }

  async initialize(language: OCRLanguage) {
    const assets = new URL(`${import.meta.env.BASE_URL}ocr/`, window.document.baseURI);
    await this.run('load', { options: { lstmOnly: true, corePath: new URL('core/', assets).href, logging: false } });
    await this.run('loadLanguage', { langs: language, options: {
      langPath: new URL('lang/', assets).href, gzip: true, lstmOnly: true,
      cachePath: 'pdf-editor-tesseract-6.0.1-model-1.0.0-best-int', cacheMethod: 'write',
    } });
    await this.run('initialize', { langs: language, oem: 1, config: {} });
    await this.run('setParameters', { params: { tessedit_pageseg_mode: '3', user_defined_dpi: '200' } });
  }

  async recognize(png: Uint8Array): Promise<RecognizedPage> {
    const image = new Uint8Array(png);
    return await this.run('recognize', {
      image, options: { rotateAuto: false, rotateRadians: 0 }, output: { text: true, blocks: true },
    }, [image.buffer]) as RecognizedPage;
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    const error = this.failure ?? abortError();
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
  }
}
