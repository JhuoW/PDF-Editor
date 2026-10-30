import { useEffect } from 'react';
import { useAnnotationStore } from '../store/annotationStore';
import { useFormStore } from '../store/formStore';
import { useEditingStore } from '../store/editingStore';
import { refreshDocumentSaveState, useDocumentSaveStore } from '../store/documentSaveStore';

export function useDocumentSaveTracking() {
  useEffect(() => {
    const unsubscribe = [
      useAnnotationStore.subscribe((next, previous) => { if (next.annotations !== previous.annotations) refreshDocumentSaveState(); }),
      useFormStore.subscribe((next, previous) => { if (next.fields !== previous.fields) refreshDocumentSaveState(); }),
      useEditingStore.subscribe((next, previous) => {
        if (next.textEdits !== previous.textEdits || next.imageEdits !== previous.imageEdits || next.redactions !== previous.redactions) refreshDocumentSaveState();
      }),
    ];
    return () => unsubscribe.forEach(stop => stop());
  }, []);
  return useDocumentSaveStore();
}
