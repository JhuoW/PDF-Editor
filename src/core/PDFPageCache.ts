import type { PDFPageProxy } from 'pdfjs-dist';

interface CachedPage {
  page: PDFPageProxy;
  canvas: HTMLCanvasElement;
  scale: number;
  rotation: number;
  timestamp: number;
}

interface CacheOptions {
  maxPages: number;
  maxMemoryMB: number;
}

export class PDFPageCache {
  private cache: Map<string, CachedPage> = new Map();
  private options: CacheOptions;

  constructor(options: Partial<CacheOptions> = {}) {
    this.options = {
      maxPages: 10,
      maxMemoryMB: 100,
      ...options,
    };
  }

  private getCacheKey(pageNumber: number, scale: number, rotation: number): string {
    return `${pageNumber}-${scale.toFixed(2)}-${rotation}`;
  }

  get(pageNumber: number, scale: number, rotation: number): HTMLCanvasElement | null {
    const key = this.getCacheKey(pageNumber, scale, rotation);
    const cached = this.cache.get(key);
    if (cached) {
      cached.timestamp = Date.now();
      return cached.canvas;
    }
    return null;
  }

  set(
    pageNumber: number,
    scale: number,
    rotation: number,
    page: PDFPageProxy,
    canvas: HTMLCanvasElement
  ): void {
    const key = this.getCacheKey(pageNumber, scale, rotation);

    // Evict old entries if cache is full
    if (this.cache.size >= this.options.maxPages) {
      this.evictOldest();
    }

    this.cache.set(key, {
      page,
      canvas,
      scale,
      rotation,
      timestamp: Date.now(),
    });
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, value] of this.cache.entries()) {
      if (value.timestamp < oldestTime) {
        oldestTime = value.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  invalidate(pageNumber?: number): void {
    if (pageNumber === undefined) {
      this.cache.clear();
    } else {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${pageNumber}-`)) {
          this.cache.delete(key);
        }
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// Singleton instance for the application
export const pageCache = new PDFPageCache();
