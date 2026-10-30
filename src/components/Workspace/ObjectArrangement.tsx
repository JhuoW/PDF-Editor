import { t, useLocale } from '../../i18n';
import { useEditingStore } from '../../store/editingStore';
import { useObjectTransformStore } from '../../store/objectTransformStore';
import { useDocumentStore } from '../../store/documentStore';
import { alignObjectRects, sameObjectRect, type ObjectAlignment } from '../../editing/objectGeometry';
import { canTransformObject, objectRect, transformObjectEdits, type ObjectTarget } from '../../editing/objectOperations';
import { mapViewportRect } from '../../utils/viewportMapping';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { commitPendingEditors } from '../../store/workspaceHistory';
import { useNativePage } from './useNativePage';

export function ObjectArrangement() {
  useLocale();
  const editing = useEditingStore(), { snappingEnabled, setSnappingEnabled, multiSelectEnabled, setMultiSelectEnabled } = useObjectTransformStore();
  const rotation = useDocumentStore(state => state.navigation.rotation);
  const targets: ObjectTarget[] = [
    ...[...editing.textBlocks.values()].flat().map(item => ({ kind: 'text' as const, item })),
    ...[...editing.images.values()].flat().map(item => ({ kind: 'image' as const, item })),
  ].filter(target => editing.selectedObjectIds.includes(target.item.id));
  const page = useNativePage(targets[0]?.item.pageNumber ?? 1);
  const enabled = targets.length > 1 && targets.every(canTransformObject) && !!page;
  const arrange = (action: ObjectAlignment) => {
    if (!enabled || !page) return;
    commitPendingEditors();
    const source = page.getViewport({ scale: 1, rotation: 0 }), display = page.getViewport({ scale: 1, rotation: getEffectiveRotation(page, rotation) });
    const before = targets.map(target => mapViewportRect(objectRect(target), source, display));
    const after = alignObjectRects(before, action);
    if (after.every((rect, index) => sameObjectRect(rect, before[index]))) return;
    const rects = after.map((rect, index) => { const mapped = mapViewportRect(rect, display, source); return { ...objectRect(targets[index]), x: mapped.x, y: mapped.y }; });
    editing.applyObjectEdits(transformObjectEdits(targets, rects), action === 'horizontal' || action === 'vertical' ? 'Distribute objects' : 'Align objects');
  };
  return <section className="inspector-card object-arrangement" aria-label={t('objects.arrange')}>
    <h3>{t(targets.length === 1 ? 'objects.selection.one' : 'objects.selection.count', { count: targets.length })}</h3>
    {targets.length > 1 && <>
      <div className="native-button-grid">{(['left', 'center', 'right', 'top', 'middle', 'bottom', 'horizontal', 'vertical'] as const).map(action =>
        <button type="button" key={action} disabled={!enabled || ((action === 'horizontal' || action === 'vertical') && targets.length < 3)} onClick={() => arrange(action)}>{t(`objects.align.${action}`)}</button>)}</div>
    </>}
    <label className="native-checkbox"><input type="checkbox" checked={multiSelectEnabled} onChange={event => setMultiSelectEnabled(event.target.checked)} />{t('objects.multi.select')}</label>
    <label className="native-checkbox"><input type="checkbox" checked={snappingEnabled} onChange={event => setSnappingEnabled(event.target.checked)} />{t('objects.snapping')}</label>
    <p>{t('objects.multi.help')}</p>
  </section>;
}
