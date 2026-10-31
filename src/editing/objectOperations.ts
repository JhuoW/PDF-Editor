import { useEditingStore } from '../store/editingStore';
import { useObjectTransformStore } from '../store/objectTransformStore';
import { imageAppearance } from './imageAppearance';
import type { ImageEditOperation, PDFImage, TextBlock, TextEditOperation, TextRect } from './types';

export type ObjectTarget = { kind: 'text'; item: TextBlock } | { kind: 'image'; item: PDFImage };
export function canTransformObject(target: ObjectTarget) {
  return target.kind === 'text' ? target.item.editable : !!target.item.source && !target.item.unsupportedReason && !target.item.source.insideForm;
}
export function objectRect(target: ObjectTarget): TextRect {
  const state = useEditingStore.getState();
  if (target.kind === 'image') return imageAppearance(target.item, state.imageEdits).rect;
  const edit = state.textEdits.find(edit => edit.blockId === target.item.id), geometry = useObjectTransformStore.getState().textGeometry.get(target.item.id);
  return edit && geometry?.signature === JSON.stringify([edit.newText, edit.layout]) ? geometry.rect : edit?.layout?.targetRect ?? target.item.rect;
}
export function textObjectEdit(block: TextBlock, rect: TextRect): TextEditOperation {
  const previous = useEditingStore.getState().textEdits.find(edit => edit.blockId === block.id), layout = previous?.layout;
  return { blockId: block.id, originalText: previous?.originalText ?? block.text, newText: block.text, timestamp: Date.now(),
    ...(previous?.font ? { font: previous.font } : {}),
    layout: { ...layout, targetRect: rect, ...(layout && !layout.keepBaseline ? {} : { keepBaseline: true, translate: true, autoGrow: false }) } };
}
export function transformObjectEdits(targets: ObjectTarget[], rects: TextRect[], resize = false) {
  const textEdits: TextEditOperation[] = [], imageEdits: ImageEditOperation[] = [];
  targets.forEach((target, index) => {
    if (!canTransformObject(target)) return;
    if (target.kind === 'text') textEdits.push(textObjectEdit(target.item, rects[index]));
    else imageEdits.push({ imageId: target.item.id, type: resize ? 'resize' : 'move', newRect: rects[index], timestamp: Date.now() });
  });
  return { textEdits, imageEdits };
}
