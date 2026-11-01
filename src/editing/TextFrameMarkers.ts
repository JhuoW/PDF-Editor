import type { TextBlock } from './types';

/** Logical wrap column, anchored to the first physical row so moving/scaling a
 * saved PDF also moves/scales its editing frame. No document text is stored. */
export interface TextFrame {
  width: number;
  xOffset: number;
  baselineOffset: number;
  fontSize: number;
  alignment: TextBlock['style']['alignment'];
  /** A natural single-row paragraph may still expand into clear space. */
  fixedWrap?: boolean;
}
const precision = 1_000_000, maximum = 14_400;
const alignments = ['left', 'center', 'right', 'justify'] as const;
function valid(frame: TextFrame) {
  return [frame.width, frame.xOffset, frame.baselineOffset, frame.fontSize].every(Number.isFinite)
    && frame.width > 0 && frame.width <= maximum && Math.abs(frame.xOffset) <= maximum
    && frame.baselineOffset > 0 && frame.baselineOffset <= maximum
    && frame.fontSize > 0 && frame.fontSize <= maximum && alignments.includes(frame.alignment)
    && (frame.fixedWrap === undefined || typeof frame.fixedWrap === 'boolean');
}
export function textFrameTag(frame: TextFrame): string | undefined {
  if (!valid(frame)) return undefined;
  return `PDFEditorFrame_${[frame.width, frame.xOffset, frame.baselineOffset, frame.fontSize]
    .map(value => Math.round(value * precision)).join('_')}_${alignments.indexOf(frame.alignment)}${frame.fixedWrap === undefined ? '' : `_F${Number(frame.fixedWrap)}`}`;
}
export function textFrameFromTag(tag: unknown): TextFrame | undefined {
  if (typeof tag !== 'string' || !/^PDFEditorFrame_\d{1,11}_-?\d{1,11}_\d{1,11}_\d{1,11}_[0-3](?:_F[01])?$/.test(tag)) return undefined;
  const fields = tag.slice('PDFEditorFrame_'.length).split('_');
  const [width, xOffset, baselineOffset, fontSize, alignment] = fields.slice(0, 5).map(Number);
  const frame = { width: width / precision, xOffset: xOffset / precision, baselineOffset: baselineOffset / precision,
    fontSize: fontSize / precision, alignment: alignments[alignment], ...(fields[5] ? { fixedWrap: fields[5] === 'F1' } : {}) };
  return valid(frame) ? frame : undefined;
}
export function scaledTextFrame(frame: TextFrame, scale: number): TextFrame | undefined {
  const scaled = { ...frame, width: frame.width * scale, xOffset: frame.xOffset * scale,
    baselineOffset: frame.baselineOffset * scale, fontSize: frame.fontSize * scale };
  return valid(scaled) ? scaled : undefined;
}
