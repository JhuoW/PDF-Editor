import { cffGlyphCIDs } from './cffCharset';
import { loadMuPDF } from '../utils/mupdf';

/** Immutable font program, identified by its content digest. */
export interface FontAsset {
  id: string; name: string; fileName: string; data: ArrayBuffer;
  bold: boolean; italic: boolean; chinese: boolean;
}
export const MAX_FONT_BYTES = 32 * 1024 * 1024;
export const MAX_LIBRARY_BYTES = 64 * 1024 * 1024;
export const isImportedFont = (name: string) => /^custom:[a-f0-9]{64}$/.test(name);

function programName(data: ArrayBuffer, fallback: string) {
  const view = new DataView(data);
  for (let table = 12; table < 12 + view.getUint16(4) * 16; table += 16) {
    if (view.getUint32(table) !== 0x6e616d65) continue;
    const start = view.getUint32(table + 8), length = view.getUint32(table + 12);
    if (length < 6) break;
    const count = view.getUint16(start + 2), strings = view.getUint16(start + 4);
    if (6 + count * 12 > length) break;
    for (let row = start + 6; row < start + 6 + count * 12; row += 12) {
      if (view.getUint16(row + 6) !== 6) continue;
      const platform = view.getUint16(row), size = view.getUint16(row + 8), offset = strings + view.getUint16(row + 10);
      if (offset + size > length || ![0, 1, 3].includes(platform)) continue;
      const value = new TextDecoder(platform === 1 ? 'ascii' : 'utf-16be').decode(new Uint8Array(data, start + offset, size));
      if (value && !Array.from(value).some(character => character.charCodeAt(0) <= 32)) return value;
    }
  }
  return fallback;
}

/** Reject collections/web fonts and invalid table ranges before parsing. */
export function validateFontData(data: ArrayBuffer) {
  if (data.byteLength > MAX_FONT_BYTES) throw new Error('A font file must be no larger than 32 MB.');
  const invalid = () => new Error('Choose a valid TTF or OTF font file. Font collections and web fonts are not supported.');
  if (data.byteLength < 12) throw invalid();
  const view = new DataView(data), signature = view.getUint32(0), count = view.getUint16(4);
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(signature) || !count || 12 + count * 16 > data.byteLength) throw invalid();
  const tables = new Set<number>();
  for (let offset = 12; offset < 12 + count * 16; offset += 16) {
    const tag = view.getUint32(offset), start = view.getUint32(offset + 8), length = view.getUint32(offset + 12);
    if (tables.has(tag) || start + length > data.byteLength) throw new Error('The font file has damaged tables.');
    tables.add(tag);
    if (tag === 0x4f532f32 && length >= 10 && (view.getUint16(start + 8) & 0x0202)) throw new Error('This font does not allow outline embedding. Choose another font.');
  }
  if (!tables.has(0x636d6170) || !tables.has(0x68656164)) throw new Error('The font file has damaged tables.');
}
export async function inspectFont(data: ArrayBuffer, fileName: string): Promise<FontAsset> {
  validateFontData(data); cffGlyphCIDs(data);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const id = `custom:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const engine = await loadMuPDF(), font = new engine.Font(programName(data, fileName), data);
  try {
    if (!font.encodeCharacter('中') && !font.encodeCharacter('A') && !font.encodeCharacter('a')) throw new Error('The font has no supported text characters.');
    return { id, name: font.getName() || fileName, fileName, data, bold: font.isBold(), italic: font.isItalic(),
      chinese: Array.from('中文字体编辑').every(character => font.encodeCharacter(character) > 0) };
  } finally { font.destroy(); }
}
