import { describe, expect, it } from 'vitest';
import { decodePDFRawStream, PDFContext, PDFDocument, PDFName, PDFNull, PDFNumber, PDFRawStream } from 'pdf-lib';
import { zlibSync } from 'fflate';
import * as mupdf from 'mupdf';
import { decodeOptimizerStream } from '../../src/core/PDFOptimizerStreams';

type Params = Record<string, number> | Array<Record<string, number> | null>;
const text = (value: string) => new TextEncoder().encode(value);
function raw(data: Uint8Array, filter?: string | string[], params?: Params, context = PDFContext.create()) {
  return PDFRawStream.of(context.obj({ Filter: filter, DecodeParms: params }), data);
}
function hex(data: Uint8Array) { return text([...data].map(value => value.toString(16).padStart(2, '0')).join('') + '>'); }
function ascii85(data: Uint8Array) {
  let result = '';
  for (let offset = 0; offset < data.length; offset += 4) {
    const count = Math.min(4, data.length - offset); let value = 0;
    for (let index = 0; index < 4; index++) value = value * 256 + (data[offset + index] ?? 0);
    if (count === 4 && value === 0) { result += 'z'; continue; }
    const group: string[] = [];
    for (let index = 0; index < 5; index++) { group.unshift(String.fromCharCode(value % 85 + 33)); value = Math.floor(value / 85); }
    result += group.slice(0, count + 1).join('');
  }
  return text(`${result}~>`);
}
function runLength(data: Uint8Array) {
  const encoded: number[] = [];
  for (let offset = 0; offset < data.length; offset += 128) {
    const chunk = data.subarray(offset, offset + 128);
    if (chunk.length > 1 && chunk.every(value => value === chunk[0])) encoded.push(257 - chunk.length, chunk[0]);
    else encoded.push(chunk.length - 1, ...chunk);
  }
  encoded.push(128); return new Uint8Array(encoded);
}
/** Codes, including CLEAR and EOD, are packed using the PDF MSB-first convention. */
function lzwCodes(codes: number[], earlyChange: number) {
  const bytes: number[] = []; let buffered = 0, bits = 0, width = 9, next = 258, previous = false;
  for (const code of codes) {
    buffered = buffered * 2 ** width + code; bits += width;
    while (bits >= 8) { bits -= 8; bytes.push((buffered >>> bits) & 255); buffered &= 2 ** bits - 1; }
    if (code === 256) { width = 9; next = 258; previous = false; continue; }
    if (code === 257) break;
    if (previous && next < 4096) { next++; if (width < 12 && next + earlyChange === 2 ** width) width++; }
    previous = true;
  }
  if (bits) bytes.push(buffered << (8 - bits));
  return new Uint8Array(bytes);
}
const lzwLiteral = (data: Uint8Array, earlyChange: number) => lzwCodes([256, ...data, 257], earlyChange);
async function oracle(data: Uint8Array, filter: string | string[], params?: Params) {
  const document = await PDFDocument.create(); document.addPage([100, 100]);
  document.catalog.set(PDFName.of('FixtureStream'), document.context.register(raw(data, filter, params, document.context)));
  const pdf = new mupdf.PDFDocument(await document.save()), buffer = pdf.getTrailer().get('Root').get('FixtureStream').readStream();
  try { return buffer.asUint8Array().slice(); } finally { buffer.destroy(); pdf.destroy(); }
}
function packSamples(samples: number[], bits: number, pad = 0) {
  const output = new Uint8Array(Math.ceil(samples.length * bits / 8));
  let position = 0;
  for (const sample of samples) for (let bit = bits - 1; bit >= 0; bit--, position++) output[position >>> 3] |= ((sample >>> bit) & 1) << (7 - (position & 7));
  if (position % 8) output[output.length - 1] |= pad & ((1 << (8 - position % 8)) - 1);
  return output;
}
function pngRows(rows: Uint8Array[], filters: number[], pixelBytes: number) {
  const encoded: number[] = [];
  for (let row = 0; row < rows.length; row++) {
    const filter = filters[row % filters.length]; encoded.push(filter);
    for (let index = 0; index < rows[row].length; index++) {
      const a = index >= pixelBytes ? rows[row][index - pixelBytes] : 0, b = row ? rows[row - 1][index] : 0, c = row && index >= pixelBytes ? rows[row - 1][index - pixelBytes] : 0;
      const distances = [Math.abs(b - c), Math.abs(a - c), Math.abs(a + b - 2 * c)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? a : distances[1] <= distances[2] ? b : c;
      encoded.push((rows[row][index] - [0, a, b, Math.floor((a + b) / 2), paeth][filter]) & 255);
    }
  }
  return new Uint8Array(encoded);
}

describe('decodeOptimizerStream', () => {
  it('returns raw bytes without an extra copy, accepts null filters, and rejects raw data beyond budget', async () => {
    const stream = raw(text('q 0 0 20 20 re f Q'));
    expect(await decodeOptimizerStream(stream, stream.contents.length, {})).toBe(stream.contents);
    stream.dict.set(PDFName.of('Filter'), PDFNull);
    expect(await decodeOptimizerStream(stream, 100, {})).toEqual(stream.contents);
    await expect(decodeOptimizerStream(stream, 1, {})).rejects.toThrow('resource limit');
    expect(await decodeOptimizerStream(raw(new Uint8Array()), 0, {})).toEqual(new Uint8Array());
  });
  it.each(['FlateDecode', 'Fl', 'ASCII85Decode', 'A85', 'ASCIIHexDecode', 'AHx', 'RunLengthDecode', 'RL', 'LZWDecode', 'LZW'])('decodes a real %s stream identically to MuPDF', async filter => {
    const expected = new Uint8Array([...text('q 0.5 g 12 24 60 30 re f Q\n'), 0, 0, 0, 0, 255, 128, 1]);
    const data = filter.startsWith('Fl') ? zlibSync(expected) : ['ASCII85Decode', 'A85'].includes(filter) ? ascii85(expected) : ['ASCIIHexDecode', 'AHx'].includes(filter) ? hex(expected) : ['RunLengthDecode', 'RL'].includes(filter) ? runLength(expected) : lzwLiteral(expected, 1);
    expect(await decodeOptimizerStream(raw(data, filter), expected.length, {})).toEqual(expected);
    expect(await oracle(data, filter)).toEqual(expected);
  });
  it('handles filter chains, indirect names, and null DecodeParms entries in order', async () => {
    const expected = text('A real content stream\n'.repeat(100)), encoded = ascii85(zlibSync(expected));
    const stream = raw(encoded, ['ASCII85Decode', 'FlateDecode'], [null, null]);
    const context = stream.dict.context;
    stream.dict.set(PDFName.of('Filter'), context.obj([context.register(PDFName.of('ASCII85Decode')), context.register(PDFName.of('FlateDecode'))]));
    expect(await decodeOptimizerStream(stream, expected.length, {})).toEqual(expected);
    expect(await oracle(encoded, ['ASCII85Decode', 'FlateDecode'], [null, null])).toEqual(expected);
    const nested = hex(runLength(ascii85(expected)));
    expect(await decodeOptimizerStream(raw(nested, ['AHx', 'RL', 'A85']), nested.length, {})).toEqual(expected);
  });
  it('handles PDF whitespace, ASCIIHex odd nibbles, ASCII85 zero groups and partial groups', async () => {
    expect(await decodeOptimizerStream(raw(text('0\u0000a\tB\f>'), 'AHx'), 2, {})).toEqual(new Uint8Array([10, 176]));
    for (const length of [0, 1, 2, 3, 4, 5]) {
      const expected = new Uint8Array(length).fill(123), encoded = ascii85(expected);
      expect(await decodeOptimizerStream(raw(encoded, 'A85'), length, {})).toEqual(expected);
    }
    expect(await decodeOptimizerStream(raw(text(' z\f z ~>'), 'A85'), 8, {})).toEqual(new Uint8Array(8));
  });
  it.each([0, 1])('decodes LZW EarlyChange=%i across 9/10/11/12-bit transitions and clear codes', async earlyChange => {
    const data = Uint8Array.from({ length: 3800 }, (_, index) => index * 37 & 255);
    const encoded = lzwCodes([256, ...data, 256, ...data.subarray(0, 800), 257], earlyChange), expected = new Uint8Array([...data, ...data.subarray(0, 800)]);
    expect(await decodeOptimizerStream(raw(encoded, 'LZWDecode', { EarlyChange: earlyChange }), expected.length, {})).toEqual(expected);
    expect(await oracle(encoded, 'LZWDecode', { EarlyChange: earlyChange })).toEqual(expected);
  });
  it('keeps a full LZW dictionary bounded while reading further literal codes', async () => {
    const expected = Uint8Array.from({ length: 6500 }, (_, index) => index * 37 & 255);
    for (const earlyChange of [0, 1]) {
      const stream = raw(lzwLiteral(expected, earlyChange), 'LZWDecode', { EarlyChange: earlyChange });
      expect(await decodeOptimizerStream(stream, expected.length, {})).toEqual(expected);
      // pdf-lib/PDF.js allow a frozen full dictionary. MuPDF requires earlier
      // CLEAR codes, which are covered independently by the native PDF fixture.
      expect(decodePDFRawStream(stream).getBytes(expected.length)).toEqual(expected);
    }
  });
  it('decodes LZW backreferences including the code-equals-next special case', async () => {
    const encoded = lzwCodes([256, 65, 258, 259, 260, 65, 258, 257], 1), expected = text('A'.repeat(13));
    expect(await decodeOptimizerStream(raw(encoded, 'LZW'), 13, {})).toEqual(expected);
    expect(await oracle(encoded, 'LZWDecode')).toEqual(expected);
  });
  it.each([10, 11, 12, 13, 14, 15])('reconstructs PNG Predictor=%i with all PNG row filters and RGB byte strides', async Predictor => {
    const rows = Array.from({ length: 6 }, (_, row) => Uint8Array.from({ length: 21 }, (_, index) => (index * 63 + row * 29) & 255));
    const filtered = pngRows(rows, Predictor === 15 ? [0, 1, 2, 3, 4] : [Predictor - 10], 3), encoded = zlibSync(filtered);
    const expected = new Uint8Array(rows.flatMap(row => [...row])), params = { Predictor, Colors: 3, Columns: 7, BitsPerComponent: 8 };
    expect(await decodeOptimizerStream(raw(encoded, 'FlateDecode', params), filtered.length, {})).toEqual(expected);
    expect(await oracle(encoded, 'FlateDecode', params)).toEqual(expected);
  });
  it.each([1, 2, 4, 8, 16])('reconstructs TIFF horizontal differences for %i-bit multicomponent samples and row padding', async bits => {
    const colors = 3, columns = 5, modulus = 2 ** bits;
    const rows = Array.from({ length: 3 }, (_, row) => Array.from({ length: colors * columns }, (_, index) => (row * 57 + index * 13) % modulus));
    const expected = new Uint8Array(rows.flatMap(row => [...packSamples(row, bits, 1)]));
    const filtered = new Uint8Array(rows.flatMap(row => [...packSamples(row.map((sample, index) => (sample - (index >= colors ? row[index - colors] : 0) + modulus) % modulus), bits, 1)]));
    const params = { Predictor: 2, Colors: colors, Columns: columns, BitsPerComponent: bits };
    expect(await decodeOptimizerStream(raw(zlibSync(filtered), 'FlateDecode', params), expected.length, {})).toEqual(expected);
    // MuPDF may normalize unused padding bits, so compare actual sample bits.
    const native = await oracle(zlibSync(filtered), 'FlateDecode', params), padding = (8 - colors * columns * bits % 8) % 8;
    if (padding) for (let row = 0; row < rows.length; row++) { const index = (row + 1) * Math.ceil(colors * columns * bits / 8) - 1; native[index] &= 255 << padding; expected[index] &= 255 << padding; }
    expect(native).toEqual(expected);
  });
  it('applies PNG predictors after LZW and within an ASCIIHex→LZW chain', async () => {
    const rows = [new Uint8Array([1, 4, 20, 30]), new Uint8Array([5, 15, 12, 240])], filtered = pngRows(rows, [1, 4], 1);
    const encoded = hex(lzwLiteral(filtered, 0)), params = [null, { Predictor: 15, Colors: 1, Columns: 4, BitsPerComponent: 8, EarlyChange: 0 }];
    expect(await decodeOptimizerStream(raw(encoded, ['ASCIIHexDecode', 'LZWDecode'], params), 100, {})).toEqual(new Uint8Array(rows.flatMap(row => [...row])));
    expect(await oracle(encoded, ['ASCIIHexDecode', 'LZWDecode'], params)).toEqual(new Uint8Array(rows.flatMap(row => [...row])));
  });
  it('uses byte-level PNG strides for packed and 16-bit pixels', async () => {
    for (const bits of [1, 2, 4, 16]) {
      const colors = 3, columns = 7, rowBytes = Math.ceil(colors * bits * columns / 8);
      const rows = [Uint8Array.from({ length: rowBytes }, (_, i) => i * 31 & 255), Uint8Array.from({ length: rowBytes }, (_, i) => i * 53 & 255)];
      const filtered = pngRows(rows, [1, 4], Math.ceil(colors * bits / 8)), params = { Predictor: 15, Colors: colors, Columns: columns, BitsPerComponent: bits };
      expect(await decodeOptimizerStream(raw(zlibSync(filtered), 'FlateDecode', params), filtered.length, {})).toEqual(new Uint8Array(rows.flatMap(row => [...row])));
    }
  });
  it('stops Flate, RunLength, ASCII85 and LZW expansion at the resource budget', async () => {
    const bombs = [raw(zlibSync(new Uint8Array(8 * 1024 * 1024)), 'FlateDecode'), raw(new Uint8Array([...Array.from({ length: 1000 }, () => [129, 65]).flat(), 128]), 'RunLengthDecode'), raw(text('z'.repeat(2000) + '~>'), 'ASCII85Decode'), raw(lzwCodes([256, 65, ...Array.from({ length: 700 }, (_, index) => index + 258), 257], 1), 'LZWDecode')];
    for (const stream of bombs) await expect(decodeOptimizerStream(stream, 1024, {})).rejects.toThrow('resource limit');
  });
  it('limits intermediate chain output even if the final output would be tiny', async () => {
    const intermediate = text(' '.repeat(2000) + '>');
    await expect(decodeOptimizerStream(raw(zlibSync(intermediate), ['FlateDecode', 'ASCIIHexDecode']), 100, {})).rejects.toThrow('resource limit');
  });
  it('rejects malformed filters, parameters, unknown codecs, and dangerous predictor dimensions', async () => {
    const unknown = raw(text('x'), 'Crypt'); await expect(decodeOptimizerStream(unknown, 100, {})).rejects.toThrow('Crypt');
    const invalidFilter = raw(text('x')); invalidFilter.dict.set(PDFName.of('Filter'), PDFNumber.of(12));
    await expect(decodeOptimizerStream(invalidFilter, 100, {})).rejects.toThrow('invalid compression filter');
    await expect(decodeOptimizerStream(raw(text('00>'), Array(17).fill('AHx')), 100, {})).rejects.toThrow('filter count');
    await expect(decodeOptimizerStream(raw(text('00>'), ['AHx', 'Fl'], [null]), 100, {})).rejects.toThrow('filter count');
    for (const params of [{ Predictor: 2, Columns: 2 ** 40 }, { Predictor: 2, BitsPerComponent: 12 }, { Predictor: 99 }, { Predictor: 2, Colors: 0 }]) {
      await expect(decodeOptimizerStream(raw(zlibSync(text('a')), 'Fl', params), 100, {})).rejects.toThrow();
    }
    await expect(decodeOptimizerStream(raw(lzwLiteral(text('a'), 1), 'LZW', { EarlyChange: 2 }), 100, {})).rejects.toThrow('EarlyChange');
  });
  it.each([
    ['AHx', text('0G>')], ['A85', text('!~>')], ['A85', text('uuuuu~>')], ['A85', text('!z~>')], ['A85', text('!!!!')],
    ['RL', new Uint8Array([3, 1])], ['RL', new Uint8Array([129])], ['RL', new Uint8Array([0, 65])],
    ['LZW', lzwCodes([256, 300, 257], 1)], ['LZW', lzwCodes([256, 65], 1)],
  ] as const)('rejects corrupt %s without substituting bytes', async (filter, data) => {
    await expect(decodeOptimizerStream(raw(data, filter), 100, {})).rejects.toThrow('invalid');
  });
  it('rejects truncated PNG/TIFF rows and invalid PNG filter bytes', async () => {
    for (const [data, params] of [[new Uint8Array([0, 1, 2]), { Predictor: 15, Columns: 4 }], [new Uint8Array([5, 1]), { Predictor: 15 }], [new Uint8Array([1, 2, 3]), { Predictor: 2, Columns: 2 }]] as const) {
      await expect(decodeOptimizerStream(raw(zlibSync(data), 'Fl', params), 100, {})).rejects.toThrow('invalid');
    }
    const damaged = zlibSync(text('checksum')); damaged[damaged.length - 1] ^= 1;
    await expect(decodeOptimizerStream(raw(damaged, 'Fl'), 100, {})).rejects.toThrow();
  });
  it('checks cancellation before decoding and while processing large textual encodings', async () => {
    const already = new AbortController(); already.abort();
    await expect(decodeOptimizerStream(raw(text('00>'), 'AHx'), 100, { signal: already.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const running = new AbortController(), encoded = hex(new Uint8Array(200000));
    const pending = decodeOptimizerStream(raw(encoded, 'ASCIIHexDecode'), 200000, { signal: running.signal });
    running.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
