import { AlertTriangle, X } from 'lucide-react';
import { useAnnotationStore } from '../../store/annotationStore';
import { useDocumentStore } from '../../store/documentStore';
import { useEditingStore } from '../../store/editingStore';
import { useUIStore } from '../../store/uiStore';
import { t, useLocale } from '../../i18n';
import { ErrorMessage } from './ErrorMessage';

/** Keep the document and recovery controls available after a failed operation. */
export function WorkspaceErrorPanel({ error, hasDocument, onCheckText }: {
  error: string; hasDocument: boolean; onCheckText: () => void;
}) {
  useLocale();
  const annotations = useAnnotationStore(state => state.annotations);
  const annotation = [...annotations.values()].flat().find(item => error.includes(item.id));
  const isTextError = !annotation && /\b(text|font|glyph|paragraph|freetext|WinAnsi)\b/i.test(error);
  const locateAnnotation = () => {
    if (!annotation) return;
    useDocumentStore.getState().setCurrentPage(annotation.pageNumber);
    useEditingStore.getState().setMode('none');
    const state = useAnnotationStore.getState();
    state.setCurrentTool('select'); state.selectAnnotation(annotation.id);
    useUIStore.getState().setInspectorOpen(true);
    useDocumentStore.getState().setError(null);
  };
  return <div className={`error-state ${hasDocument ? 'document-error' : ''}`} role="alert">
    <AlertTriangle size={20} aria-hidden="true" />
    <div className="workspace-error-message">{t('m.error.787aa1')}{' '}<ErrorMessage error={error} />
      {annotation && <button type="button" className="toolbar-btn" onClick={locateAnnotation}>{t(annotation.type === 'image' ? 'workspace.error.locateImage' : 'workspace.error.locateAnnotation')}</button>}
      {hasDocument && isTextError && <button type="button" className="toolbar-btn" onClick={onCheckText}>{t('text.check.title')}</button>}
    </div>
    <button type="button" className="toolbar-btn" aria-label={t('m.dismiss.70afe9')} onClick={() => useDocumentStore.getState().setError(null)}><X size={16} aria-hidden="true" /><span>{t('m.dismiss.70afe9')}</span></button>
  </div>;
}
