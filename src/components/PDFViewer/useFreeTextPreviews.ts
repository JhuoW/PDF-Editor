import { useEffect, useRef, useState } from 'react';
import type { Annotation, FreeTextAnnotation } from '../../annotations/types';
import { requestFreeTextPreview } from '../../annotations/FreeTextPreviewClient';
import { useAnnotationStore } from '../../store/annotationStore';

interface Preview { key: string; image?: HTMLImageElement; height: number; contentHeight?: number; error?: string }
export function freeTextPreviewKey(annotation: FreeTextAnnotation, scale: number) {
  return JSON.stringify([annotation.content, annotation.richContent, annotation.style, annotation.boxStyle, annotation.rect[2], annotation.rect[3], annotation.opacity, scale]);
}
/** Stale workers never resize or repaint a newer draft, an undo state, or another document. */
export function useFreeTextPreviews(annotations: Annotation[], scale: number) {
  const [previews, setPreviews] = useState<Map<string, Preview>>(() => new Map());
  const pending = useRef(new Map<string, { key: string; controller: AbortController }>());
  const cache = useRef(new Map<string, Preview>());
  useEffect(() => {
    const current = new Set(annotations.filter(annotation => annotation.type === 'freetext').map(annotation => annotation.id));
    for (const [id, request] of pending.current) if (!current.has(id)) { request.controller.abort(); pending.current.delete(id); }
    for (const id of cache.current.keys()) if (!current.has(id)) cache.current.delete(id);
    for (const annotation of annotations) {
      if (annotation.type !== 'freetext') continue;
      const key = freeTextPreviewKey(annotation, scale), prior = pending.current.get(annotation.id);
      if (cache.current.get(annotation.id)?.key === key || prior?.key === key) continue;
      prior?.controller.abort();
      const controller = new AbortController(); pending.current.set(annotation.id, { key, controller });
      void requestFreeTextPreview(annotation, Math.min(3, scale * (window.devicePixelRatio || 1)), controller.signal).then(async result => {
        const image = new Image(), url = URL.createObjectURL(new Blob([result.png], { type: 'image/png' }));
        try { image.src = url; await image.decode(); } finally { URL.revokeObjectURL(url); }
        if (controller.signal.aborted) return;
        const store = useAnnotationStore.getState(), current = store.getAnnotationsForPage(annotation.pageNumber).find(item => item.id === annotation.id);
        if (!current || current.type !== 'freetext' || freeTextPreviewKey(current, scale) !== key) return;
        let nextKey = key;
        if (result.height > current.rect[3] + .01) {
          const rect: FreeTextAnnotation['rect'] = [current.rect[0], current.rect[1] + current.rect[3] - result.height, current.rect[2], result.height];
          // Height is derived from the content, like a line wrap. The user's text
          // command already owns the undo checkpoint; do not add a second action.
          const updated = { ...current, rect };
          nextKey = freeTextPreviewKey(updated, scale);
          store.updateAnnotation(current.id, { rect });
        }
        cache.current.set(annotation.id, { key: nextKey, image, height: result.height, contentHeight: result.contentHeight });
        setPreviews(new Map(cache.current));
      }).catch(error => {
        if (controller.signal.aborted) return;
        cache.current.set(annotation.id, { key, height: annotation.rect[3], error: error instanceof Error ? error.message : String(error) });
        setPreviews(new Map(cache.current));
      }).finally(() => { if (pending.current.get(annotation.id)?.key === key) pending.current.delete(annotation.id); });
    }
  }, [annotations, scale]);
  useEffect(() => {
    const requests = pending.current;
    return () => { for (const request of requests.values()) request.controller.abort(); requests.clear(); };
  }, []);
  return previews;
}
