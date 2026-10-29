import { PDFArray, PDFDict, PDFName, PDFNull, PDFNumber, PDFRawStream } from 'pdf-lib';
import type { OptimizerControl } from './PDFOptimizerTypes';

const CHUNK_SIZE = 65536;
const budgetError = () => new Error('A decoded PDF stream exceeds the optimizer’s resource limit.');
const invalid = (encoding: string) => new Error(`A PDF stream has invalid ${encoding} data. The original PDF was preserved.`);
const space = (byte: number) => byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
async function checkpoint(control: OptimizerControl) {
  control.signal?.throwIfAborted();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  control.signal?.throwIfAborted();
}

/** Fixed-size chunks avoid both unbounded expansion and geometric over-allocation. */
class BoundedOutput {
  private chunks: Uint8Array[] = [];
  private current = new Uint8Array(0);
  private used = 0;
  private length = 0;
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  private reserve(count: number) { if (count > this.limit - this.length) throw budgetError(); }
  private write(byte: number) {
    if (this.used === this.current.length) {
      this.current = new Uint8Array(Math.min(CHUNK_SIZE, this.limit - this.length));
      this.chunks.push(this.current); this.used = 0;
    }
    this.current[this.used++] = byte; this.length++;
  }
  byte(byte: number) { this.reserve(1); this.write(byte); }
  append(bytes: Uint8Array) {
    this.reserve(bytes.length);
    let offset = 0;
    while (offset < bytes.length) {
      if (this.used === this.current.length) { this.write(bytes[offset++]); continue; }
      const count = Math.min(this.current.length - this.used, bytes.length - offset);
      this.current.set(bytes.subarray(offset, offset + count), this.used);
      this.used += count; this.length += count; offset += count;
    }
  }
  repeat(byte: number, count: number) { this.reserve(count); for (let i = 0; i < count; i++) this.write(byte); }
  reversed(bytes: Uint8Array, count: number, extra?: number) {
    this.reserve(count + (extra === undefined ? 0 : 1));
    for (let i = count - 1; i >= 0; i--) this.write(bytes[i]);
    if (extra !== undefined) this.write(extra);
  }
  finish() {
    const output = new Uint8Array(this.length); let offset = 0;
    for (const chunk of this.chunks) { const count = Math.min(chunk.length, this.length - offset); output.set(chunk.subarray(0, count), offset); offset += count; }
    return output;
  }
}

async function inflate(data: Uint8Array, limit: number, control: OptimizerControl) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser does not support bounded PDF stream decompression.');
  const reader = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const output = new BoundedOutput(limit);
  const abort = () => { void reader.cancel(control.signal?.reason).catch(() => {}); };
  control.signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      control.signal?.throwIfAborted(); const chunk = await reader.read(); control.signal?.throwIfAborted();
      if (chunk.done) break;
      output.append(chunk.value);
    }
    return output.finish();
  } finally { control.signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function asciiHex(data: Uint8Array, limit: number, control: OptimizerControl) {
  const output = new BoundedOutput(limit); let high = -1;
  for (let i = 0; i < data.length; i++) {
    if (i && (i & 65535) === 0) await checkpoint(control);
    const value = data[i]; if (value === 62) break; if (space(value)) continue;
    const digit = value >= 48 && value <= 57 ? value - 48 : value >= 65 && value <= 70 ? value - 55 : value >= 97 && value <= 102 ? value - 87 : -1;
    if (digit < 0) throw invalid('ASCIIHex');
    if (high < 0) high = digit; else { output.byte((high << 4) | digit); high = -1; }
  }
  if (high >= 0) output.byte(high << 4);
  return output.finish();
}
async function ascii85(data: Uint8Array, limit: number, control: OptimizerControl) {
  const output = new BoundedOutput(limit); let value = 0, digits = 0;
  for (let i = 0; i < data.length; i++) {
    if (i && (i & 65535) === 0) await checkpoint(control);
    const byte = data[i]; if (space(byte)) continue;
    if (byte === 126) {
      if (data[i + 1] !== 62 || digits === 1) throw invalid('ASCII85');
      if (digits) {
        const count = digits - 1;
        while (digits++ < 5) value = value * 85 + 84;
        if (value > 0xffffffff) throw invalid('ASCII85');
        for (let index = 0; index < count; index++) output.byte((value >>> ((3 - index) * 8)) & 255);
      }
      return output.finish();
    }
    if (byte === 122) { if (digits) throw invalid('ASCII85'); output.repeat(0, 4); continue; }
    if (byte < 33 || byte > 117) throw invalid('ASCII85');
    value = value * 85 + byte - 33;
    if (++digits === 5) {
      if (value > 0xffffffff) throw invalid('ASCII85');
      for (let shift = 24; shift >= 0; shift -= 8) output.byte((value >>> shift) & 255);
      digits = 0; value = 0;
    }
  }
  throw invalid('ASCII85 (missing end marker)');
}
async function runLength(data: Uint8Array, limit: number, control: OptimizerControl) {
  const output = new BoundedOutput(limit); let blocks = 0;
  for (let i = 0; i < data.length;) {
    if (++blocks % 16384 === 0) await checkpoint(control);
    const length = data[i++]; if (length === 128) return output.finish();
    if (length < 128) {
      const count = length + 1;
      if (i + count > data.length) throw invalid('RunLength');
      output.append(data.subarray(i, i + count)); i += count;
    } else { if (i === data.length) throw invalid('RunLength'); output.repeat(data[i++], 257 - length); }
  }
  throw invalid('RunLength (missing end marker)');
}
async function lzw(data: Uint8Array, limit: number, earlyChange: number, control: OptimizerControl) {
  if (earlyChange !== 0 && earlyChange !== 1) throw invalid('LZW EarlyChange');
  const output = new BoundedOutput(limit), prefixes = new Uint16Array(4096), suffixes = new Uint8Array(4096), sequence = new Uint8Array(4096);
  let bit = 0, width = 9, next = 258, previous = -1, codes = 0;
  const unpack = (code: number) => {
    let length = 0;
    while (code >= 258) {
      if (code >= next || length >= 4095) throw invalid('LZW dictionary');
      sequence[length++] = suffixes[code]; code = prefixes[code];
    }
    if (code > 255) throw invalid('LZW dictionary');
    sequence[length++] = code; return length;
  };
  while (true) {
    if (++codes % 1024 === 0) await checkpoint(control);
    if (bit + width > data.length * 8) throw invalid('LZW (missing end code)');
    let code = 0;
    for (let i = 0; i < width; i++, bit++) code = code * 2 + ((data[bit >>> 3] >>> (7 - (bit & 7))) & 1);
    if (code === 257) return output.finish();
    if (code === 256) { width = 9; next = 258; previous = -1; continue; }
    const special = code === next && previous !== -1;
    if (code >= next && !special) throw invalid('LZW code');
    const length = unpack(special ? previous : code), first = sequence[length - 1];
    output.reversed(sequence, length, special ? first : undefined);
    if (previous !== -1 && next < 4096) {
      prefixes[next] = previous; suffixes[next] = first; next++;
      if (width < 12 && next + earlyChange === 2 ** width) width++;
    }
    previous = code;
  }
}

function parameter(dict: PDFDict | undefined, name: string, fallback: number) {
  const value = dict?.lookup(PDFName.of(name));
  if (value === undefined || value === PDFNull) return fallback;
  if (!(value instanceof PDFNumber) || !Number.isSafeInteger(value.asNumber())) throw invalid(`DecodeParms /${name}`);
  return value.asNumber();
}
async function predictor(data: Uint8Array, params: PDFDict | undefined, limit: number, control: OptimizerControl) {
  const prediction = parameter(params, 'Predictor', 1);
  if (prediction === 1) return data;
  if (prediction !== 2 && (prediction < 10 || prediction > 15)) throw invalid('Predictor');
  const colors = parameter(params, 'Colors', 1), bits = parameter(params, 'BitsPerComponent', 8), columns = parameter(params, 'Columns', 1);
  if (colors < 1 || columns < 1 || ![1, 2, 4, 8, 16].includes(bits)) throw invalid('Predictor dimensions');
  const rowBits = colors * bits * columns, rowBytes = Math.ceil(rowBits / 8), pixelBytes = Math.ceil(colors * bits / 8);
  if (!Number.isSafeInteger(rowBits) || rowBytes > limit) throw budgetError();
  const encodedRowBytes = rowBytes + (prediction === 2 ? 0 : 1);
  if (data.length % encodedRowBytes !== 0) throw invalid('Predictor row length');
  const rows = data.length / encodedRowBytes, output = prediction === 2 ? data.slice() : new Uint8Array(rows * rowBytes);
  if (prediction === 2) {
    const mask = 2 ** bits - 1, components = colors * columns;
    for (let row = 0; row < rows; row++) {
      const start = row * rowBytes;
      for (let component = colors; component < components; component++) {
        if (((row * components + component) & 65535) === 0) await checkpoint(control);
        const bit = component * bits, leftBit = (component - colors) * bits;
        if (bits === 16) {
          const position = start + bit / 8, left = start + leftBit / 8;
          const value = ((output[position] << 8) | output[position + 1]) + ((output[left] << 8) | output[left + 1]);
          output[position] = (value >>> 8) & 255; output[position + 1] = value & 255;
        } else {
          const position = start + (bit >>> 3), shift = 8 - bits - (bit & 7), left = start + (leftBit >>> 3), leftShift = 8 - bits - (leftBit & 7);
          const value = (((output[position] >>> shift) & mask) + ((output[left] >>> leftShift) & mask)) & mask;
          output[position] = (output[position] & ~(mask << shift)) | (value << shift);
        }
      }
      if (row && (row & 65535) === 0) await checkpoint(control);
    }
    return output;
  }
  for (let row = 0; row < rows; row++) {
    const input = row * encodedRowBytes, start = row * rowBytes, filter = data[input];
    if (filter > 4) throw invalid('PNG predictor');
    for (let column = 0; column < rowBytes; column++) {
      const position = start + column;
      if (position && (position & 65535) === 0) await checkpoint(control);
      const left = column >= pixelBytes ? output[position - pixelBytes] : 0, up = row ? output[position - rowBytes] : 0, upperLeft = row && column >= pixelBytes ? output[position - rowBytes - pixelBytes] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      if (filter === 2) prediction = up;
      if (filter === 3) prediction = Math.floor((left + up) / 2);
      if (filter === 4) {
        const value = left + up - upperLeft, a = Math.abs(value - left), b = Math.abs(value - up), c = Math.abs(value - upperLeft);
        prediction = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      }
      output[position] = (data[input + column + 1] + prediction) & 255;
    }
  }
  return output;
}

/** Decode each filter separately, with a strict output budget at every stage.
 * pdf-lib's getBytes(n) is insufficient: a single Flate readBlock can expand
 * an entire deflate block, and its DecodeStream retains/grows the whole buffer.
 * Predictor bytes count toward the intermediate stage's budget as well. */
export async function decodeOptimizerStream(stream: PDFRawStream, limit: number, control: OptimizerControl): Promise<Uint8Array> {
  control.signal?.throwIfAborted();
  if (!Number.isSafeInteger(limit) || limit < 0) throw budgetError();
  const filter = stream.dict.lookup(PDFName.of('Filter')), decodeParams = stream.dict.lookup(PDFName.of('DecodeParms'));
  if (filter instanceof PDFArray && filter.size() > 16) throw invalid('compression filter count');
  const filters = filter instanceof PDFName ? [filter] : filter instanceof PDFArray ? Array.from({ length: filter.size() }, (_, index) => filter.lookup(index)) : filter === undefined || filter === PDFNull ? [] : null;
  if (!filters || filters.some(value => !(value instanceof PDFName))) throw invalid('compression filter');
  if (decodeParams !== undefined && decodeParams !== PDFNull && !(decodeParams instanceof PDFDict) && !(decodeParams instanceof PDFArray)) throw invalid('DecodeParms');
  if (decodeParams instanceof PDFArray && decodeParams.size() !== filters.length || decodeParams instanceof PDFDict && filters.length !== 1) throw invalid('DecodeParms filter count');
  let data = stream.getContents();
  if (!filters.length) { if (data.length > limit) throw budgetError(); return data; }
  for (let index = 0; index < filters.length; index++) {
    control.signal?.throwIfAborted();
    const encoding = (filters[index] as PDFName).decodeText(), rawParams = decodeParams instanceof PDFArray ? decodeParams.lookup(index) : decodeParams;
    if (rawParams !== undefined && rawParams !== PDFNull && !(rawParams instanceof PDFDict)) throw invalid('DecodeParms');
    const params = rawParams instanceof PDFDict ? rawParams : undefined;
    if (encoding === 'FlateDecode' || encoding === 'Fl') data = await inflate(data, limit, control);
    else if (encoding === 'ASCII85Decode' || encoding === 'A85') data = await ascii85(data, limit, control);
    else if (encoding === 'ASCIIHexDecode' || encoding === 'AHx') data = await asciiHex(data, limit, control);
    else if (encoding === 'RunLengthDecode' || encoding === 'RL') data = await runLength(data, limit, control);
    else if (encoding === 'LZWDecode' || encoding === 'LZW') data = await lzw(data, limit, parameter(params, 'EarlyChange', 1), control);
    else throw new Error(`The optimizer cannot safely verify this stream encoding (${encoding}). The original PDF was preserved.`);
    if (['FlateDecode', 'Fl', 'LZWDecode', 'LZW'].includes(encoding)) data = await predictor(data, params, limit, control);
    control.signal?.throwIfAborted();
  }
  return data;
}
