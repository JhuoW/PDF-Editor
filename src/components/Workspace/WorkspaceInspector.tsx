import { useLocale, t } from "../../i18n";
import { FileText, Info, SlidersHorizontal, X, Type, Image as ImageIcon, ShieldCheck } from 'lucide-react';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import { useAnnotationStore } from '../../store/annotationStore';
import { useDocumentStore } from '../../store/documentStore';
import { useEditingStore } from '../../store/editingStore';
import { useUIStore } from '../../store/uiStore';
import { TextPropertiesPanel } from '../TextBox/TextPropertiesPanel';
import { BoxPropertiesPanel } from '../TextBox/BoxPropertiesPanel';
import { ImagePropertiesPanel } from '../ImageToolbar/ImagePropertiesPanel';
import type { FreeTextAnnotation, ImageAnnotation } from '../../annotations/types';

export function WorkspaceInspector({ onTextLayout, onProperties, isBusy }: { onTextLayout: (id: string) => void; onProperties: () => void; isBusy: boolean }) {
  useLocale();
  const { inspectorOpen, inspectorSection, setInspectorOpen, setInspectorSection } = useUIStore();
  const recordUpdate = useAnnotationHistoryStore(state => state.recordUpdate);
  const annotationStore = useAnnotationStore(), editing = useEditingStore();
  const { document, navigation } = useDocumentStore();
  const selected = [...annotationStore.annotations.values()].flat().find(item => item.id === annotationStore.selectedAnnotationId);
  const block = [...editing.textBlocks.values()].flat().find(item => item.id === editing.selectedBlockId);
  const nativeImage = [...editing.images.values()].flat().find(item => item.id === editing.selectedImageId);
  const imageRect = nativeImage && editing.imageEdits.filter(edit => edit.imageId === nativeImage.id).reduce((rect, edit) => edit.newRect ?? rect, nativeImage.rect);
  const closeInspector = () => {
    setInspectorOpen(false);
    window.document.getElementById('workspace-inspector-toggle')?.focus();
  };
  const activeTextSection = inspectorSection === 'box' ? 'box' : 'text';
  return <aside id="workspace-inspector-root" className={`workspace-inspector ${inspectorOpen ? 'open' : ''}`} aria-label={t("m.properties.bc6c88")} inert={isBusy}>
    <header><div><SlidersHorizontal size={17} /><h2>{t("m.properties.bc6c88")}</h2></div><button type="button" className="toolbar-btn icon-only" aria-label={t("m.close.properties.20b956")} onClick={closeInspector}><X size={16} /></button></header>
    {selected?.type === 'freetext' ? <>
      <div className="inspector-tabs" role="tablist" aria-label={t("m.text.properties.5aa98f")} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 'text' : event.key === 'End' ? 'box' : activeTextSection === 'text' ? 'box' : 'text';
        setInspectorSection(next);
        window.document.getElementById(`workspace-properties-${next}`)?.focus();
      }}><button role="tab" id="workspace-properties-text" tabIndex={activeTextSection === 'text' ? 0 : -1} aria-selected={activeTextSection === 'text'} aria-controls="workspace-properties-panel" onClick={() => setInspectorSection('text')}>{t("m.text.c3328c")}</button><button role="tab" id="workspace-properties-box" tabIndex={activeTextSection === 'box' ? 0 : -1} aria-selected={activeTextSection === 'box'} aria-controls="workspace-properties-panel" onClick={() => setInspectorSection('box')}>{t("m.box.239ca5")}</button></div>
      <div className="inspector-content" role="tabpanel" id="workspace-properties-panel" aria-labelledby={`workspace-properties-${activeTextSection}`}>{inspectorSection === 'box' ? <BoxPropertiesPanel annotation={selected as FreeTextAnnotation} /> : <TextPropertiesPanel annotation={selected as FreeTextAnnotation} />}</div>
    </> : selected?.type === 'image' ? <div className="inspector-content"><ImagePropertiesPanel annotation={selected as ImageAnnotation} onClose={closeInspector} /></div>
      : <div className="inspector-content">
        {block ? <section className="inspector-card"><Type size={24} /><h3>{t("m.original.pdf.text.9acab0")}</h3><dl><dt>{t("m.font.size.83ca9e")}</dt><dd>{block.style.fontSize.toFixed(1)}{' '}{t("m.pt.bc8112")}</dd></dl><button className="inspector-primary" disabled={!block.editable} onClick={() => onTextLayout(block.id)}>{t("m.text.layout.661a8e")}</button>{editing.mode === 'object' && <button className="inspector-link" disabled={!block.editable} onClick={() => editing.requestTextEdit(block.id)}>{t('objects.edit.text')}</button>}</section>
        : nativeImage && imageRect ? <section className="inspector-card"><ImageIcon size={24} /><h3>{t('objects.original.image')}</h3><dl><dt>{t('objects.position')}</dt><dd>{imageRect.x.toFixed(1)}, {imageRect.y.toFixed(1)}{' '}{t("m.pt.bc8112")}</dd><dt>{t('objects.size')}</dt><dd>{imageRect.width.toFixed(1)} × {imageRect.height.toFixed(1)}{' '}{t("m.pt.bc8112")}</dd></dl><button className="inspector-primary" onClick={() => { editing.setMode('image'); editing.selectImage(nativeImage.id); }}>{t('objects.image.options')}</button></section>
        : selected ? <section className="inspector-card"><ImageIcon size={24} /><h3>{t("m.annotation.de3b78")}</h3><label>{t("m.color.1d0c83")}<input type="color" aria-label={t("m.annotation.color.c86abe")} value={selected.color ?? '#2563eb'} onChange={event => { const next = { ...selected, color: event.target.value }; annotationStore.updateAnnotation(selected.id, { color: event.target.value }); recordUpdate(next, selected); }} /></label><p>{t("m.use.the.selection.handles.to.move.or.resize.this.354a43")}</p></section>
        : <section className="inspector-empty"><div><SlidersHorizontal size={26} /></div><h3>{t("m.nothing.selected.3d95f4")}</h3><p>{t("m.select.a.page.text.or.annotation.to.see.availabl.8dac63")}</p></section>}
        <section className="inspector-card document-summary"><div className="inspector-section-title"><FileText size={16} /><h3>{t("m.document.e214b8")}</h3></div><dl><dt>{t("m.pages.600584")}</dt><dd>{navigation.totalPages}</dd><dt>{t("m.current.page.af778b")}</dt><dd>{navigation.currentPage}</dd></dl><button type="button" className="inspector-link" onClick={onProperties} disabled={!document}><Info size={14} />{t("m.document.properties.e6de11")}</button></section>
        <div className="privacy-note"><ShieldCheck size={16} /><p>{t("m.your.document.stays.on.this.device.a48977")}</p></div>
      </div>}
  </aside>;
}
