export function cffTableData(data: ArrayBuffer): Uint8Array | undefined {
  const view = new DataView(data);
  for (let row = 12; row < 12 + view.getUint16(4) * 16; row += 16) {
    if (view.getUint32(row) === 0x43464620) return new Uint8Array(data, view.getUint32(row + 8), view.getUint32(row + 12));
  }
}
/** CFF CID fonts may use non-identity GID → CID charsets (notably subset Chinese OTFs).
 * MuPDF's PDF device emits GIDs as character codes. Keep the charset for a matching PDF CMap.
 */
export function cffGlyphCIDs(data: ArrayBuffer): number[] | undefined {
  const bytes = cffTableData(data);
  if (!bytes) return;
  const length = bytes.byteLength, view = new DataView(bytes.buffer, bytes.byteOffset, length);
  const invalid = () => new Error('The font file has damaged tables.');
  const uint = (offset: number, size: number) => {
    if (offset < 0 || offset + size > length || size < 1 || size > 4) throw invalid();
    let value = 0; for (let i = 0; i < size; i++) value = value * 256 + bytes[offset + i]; return value;
  };
  const index = (offset: number) => {
    const count = uint(offset, 2); if (!count) return { end: offset + 2, objects: [] as Array<[number, number]> };
    const size = uint(offset + 2, 1), start = offset + 3 + (count + 1) * size, offsets: number[] = [];
    for (let i = 0; i <= count; i++) offsets.push(uint(offset + 3 + i * size, size));
    if (offsets[0] !== 1 || start + offsets[count] - 1 > length || offsets.some((value, i) => i && value < offsets[i - 1])) throw invalid();
    return { end: start + offsets[count] - 1, objects: offsets.slice(0, -1).map((value, i) => [start + value - 1, start + offsets[i + 1] - 1] as [number, number]) };
  };
  if (uint(0, 1) !== 1) throw invalid();
  const names = index(uint(2, 1)), top = index(names.end).objects[0]; if (!top) throw invalid();
  let cid = false, charset = 0, charStrings = 0;
  const operands: number[] = [];
  for (let offset = top[0]; offset < top[1];) {
    const byte = uint(offset++, 1);
    if (byte >= 32 && byte <= 246) operands.push(byte - 139);
    else if (byte >= 247 && byte <= 250) operands.push((byte - 247) * 256 + uint(offset++, 1) + 108);
    else if (byte >= 251 && byte <= 254) operands.push(-(byte - 251) * 256 - uint(offset++, 1) - 108);
    else if (byte === 28 || byte === 29) {
      const size = byte === 28 ? 2 : 4; uint(offset, size);
      operands.push(size === 2 ? view.getInt16(offset) : view.getInt32(offset)); offset += size;
    } else if (byte === 30) {
      // Real-valued metrics are irrelevant to charset offsets, but must be skipped correctly.
      let value: number; do { value = uint(offset++, 1); } while ((value & 15) !== 15 && value >> 4 !== 15);
      operands.push(NaN);
    } else {
      const operator = byte === 12 ? 1200 + uint(offset++, 1) : byte;
      if (operator === 1230) cid = true;
      if (operator === 15) charset = operands[0];
      if (operator === 17) charStrings = operands[0];
      operands.length = 0;
    }
  }
  if (!cid) return;
  if (!Number.isInteger(charset) || charset <= 2 || !Number.isInteger(charStrings) || charStrings <= 0) throw invalid();
  const count = uint(charStrings, 2), result = [0], format = uint(charset, 1);
  if (!count || format > 2) throw invalid();
  let offset = charset + 1;
  while (result.length < count) {
    const first = uint(offset, 2); offset += 2;
    const extra = format === 0 ? 0 : uint(offset, format === 1 ? 1 : 2); offset += format;
    if (result.length + extra + 1 > count || first + extra > 65535) throw invalid();
    for (let i = 0; i <= extra; i++) result.push(first + i);
  }
  if (new Set(result).size !== result.length) throw invalid();
  return result.some((value, gid) => value !== gid) ? result : undefined;
}
