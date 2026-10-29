import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyPageDecorations, inspectPageDecorations, PAGE_DECORATION_MARKERS as MARK, type HeaderFooterDecoration, type WatermarkDecoration } from '../../src/core/PageDecorations';
import { copyPagesWithForms } from '../../src/core/copyPagesWithForms';

const buffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;
const watermark = (pages = [1]): WatermarkDecoration => ({ kind: 'watermark', name: 'Draft', pages, opacity: 0.35, layer: 'foreground', angle: 0, position: { anchor: 'center', offsetX: 0, offsetY: 0 }, content: { type: 'text', text: 'SECRET WATERMARK', fontFamily: 'Helvetica', fontSize: 20, color: '#CC0000' } });
const footer = (pages = [1, 2, 3]): HeaderFooterDecoration => ({ kind: 'header-footer', name: 'Pagination', pages, opacity: 1, layer: 'foreground', slots: { footerLeft: 'Page {page}/{pages}', footerRight: '{bates}' }, fontFamily: 'Courier', fontSize: 10, color: '#000000', marginX: 15, marginTop: 15, marginBottom: 15, pageNumberStart: 5, bates: { start: 99, digits: 5, prefix: 'CASE-', suffix: '-X' } });
async function source(count = 1, rotation = 0, unit = 1) {
  const pdf = await PDFDocument.create(); pdf.setTitle('Keep metadata');
  for (let n = 0; n < count; n++) { const page = pdf.addPage([400, 500]); page.setCropBox(40, 60, 300, 400); page.setRotation(degrees(rotation)); page.node.set(PDFName.of('UserUnit'), PDFNumber.of(unit)); page.drawText(`ORIGINAL PAGE ${n + 1}`, { x: 60, y: 380, size: 15 }); page.drawRectangle({ x: 60, y: 80, width: 20, height: 20, color: rgb(0, 0, 0) }); }
  const field = pdf.getForm().createTextField('preserved'); field.setText('VALUE'); field.addToPage(pdf.getPage(0), { x: 90, y: 150, width: 90, height: 25 });
  await pdf.attach(new Uint8Array([11, 22, 33]), 'keep.bin');
  return buffer(await pdf.save());
}
function render(bytes: ArrayBuffer | Uint8Array, index = 0) {
  const document = new mupdf.PDFDocument(new Uint8Array(bytes)), page = document.loadPage(index), text = page.toStructuredText(''), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
  try { return { text: text.asText(), width: pixmap.getWidth(), height: pixmap.getHeight(), pixels: new Uint8Array(pixmap.getPixels()) }; }
  finally { pixmap.destroy(); text.destroy(); page.destroy(); document.destroy(); }
}
function image() { const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 10], false); try { pixmap.getPixels().fill(180); return new Uint8Array(pixmap.asPNG()); } finally { pixmap.destroy(); } }
async function mutate(bytes: Uint8Array, action: (document: mupdf.PDFDocument) => void) {
  const document = new mupdf.PDFDocument(bytes); try { action(document); const saved = document.saveToBuffer('garbage=1,compress'); try { return new Uint8Array(saved.asUint8Array()); } finally { saved.destroy(); } } finally { document.destroy(); }
}
describe('managed page decorations', () => {
  it('reopens, updates, and truly removes only owned content while keeping fields, attachments, metadata and original pixels', async () => {
    const original = await source(), before = await PDFDocument.load(original), widget = before.getForm().getTextField('preserved').acroField.getWidgets()[0].dict;
    const widgetRef = before.context.getObjectRef(widget)?.toString();
    const marked = await applyPageDecorations(original, [{ type: 'create', definition: watermark() }]);
    const inspected = await inspectPageDecorations(buffer(marked));
    expect(inspected.decorations).toHaveLength(1); expect(inspected.decorations[0]).toMatchObject({ managed: true, needsRefresh: false, pages: [1] });
    expect(render(marked).text).toContain('SECRET WATERMARK');
    const definition = watermark(); definition.content = { type: 'text', text: 'REPLACED 中文', fontFamily: 'Times', fontSize: 18, color: '#0000FF' };
    const updated = await applyPageDecorations(buffer(marked), [{ type: 'update', id: inspected.decorations[0].id, definition }]);
    expect(render(updated).text).toContain('REPLACED'); expect(render(updated).text).not.toContain('SECRET');
    const removed = await applyPageDecorations(buffer(updated), [{ type: 'remove', id: inspected.decorations[0].id }]);
    expect((await inspectPageDecorations(buffer(removed))).decorations).toEqual([]); expect(render(removed).pixels).toEqual(render(original).pixels);
    const pdf = await PDFDocument.load(removed); expect(pdf.getTitle()).toBe('Keep metadata'); expect(pdf.getForm().getTextField('preserved').getText()).toBe('VALUE'); expect(pdf.context.getObjectRef(pdf.getForm().getTextField('preserved').acroField.getWidgets()[0].dict)?.toString()).toBe(widgetRef);
    expect(pdf.catalog.lookup(PDFName.of('Names')).toString()).toContain('EmbeddedFiles');
    const native = new mupdf.PDFDocument(removed); try { for (let i = 1; i < native.countObjects(); i++) { const object = native.newIndirect(i); try { expect(object.toString()).not.toContain('SECRET WATERMARK'); if (object.isStream()) { const content = object.readStream(); try { expect(new TextDecoder().decode(content.asUint8Array())).not.toContain('SECRET WATERMARK'); } finally { content.destroy(); } } } finally { object.destroy(); } } } finally { native.destroy(); }
  });
  it.each([0, 90, 180, 270])('places on the actual visible page with rotation %s, CropBox and UserUnit', async rotation => {
    const definition = watermark(); definition.opacity = 1; definition.angle = 30; definition.position = { anchor: 'top-left', offsetX: 12, offsetY: 14 };
    const original = await source(1, rotation, 2), output = await applyPageDecorations(original, [{ type: 'create', definition }]);
    const inspected = await inspectPageDecorations(buffer(output)), bounds = inspected.decorations[0].placements[0].bounds;
    expect(bounds.x).toBeCloseTo(12); expect(bounds.y).toBeCloseTo(14); expect(inspected.decorations[0].managed).toBe(true);
    const old = render(original), next = render(output); let changed = 0;
    for (let y = 0; y < next.height; y++) for (let x = 0; x < next.width; x++) { const offset = (y * next.width + x) * 3; if (next.pixels[offset] !== old.pixels[offset] || next.pixels[offset + 1] !== old.pixels[offset + 1] || next.pixels[offset + 2] !== old.pixels[offset + 2]) { changed++; expect(x).toBeGreaterThanOrEqual(Math.floor(bounds.x) - 2); expect(y).toBeGreaterThanOrEqual(Math.floor(bounds.y) - 2); expect(x).toBeLessThanOrEqual(Math.ceil(bounds.x + bounds.width) + 2); expect(y).toBeLessThanOrEqual(Math.ceil(bounds.y + bounds.height) + 2); } }
    expect(changed).toBeGreaterThan(100);
  });
  it('resolves actual page numbers and ordered Bates, and previews only the requested page', async () => {
    const original = await source(3), definition = footer([3, 1]);
    const output = await applyPageDecorations(original, [{ type: 'create', definition }]);
    expect(render(output, 2).text).toContain('Page 7/3'); expect(render(output, 2).text).toContain('CASE-00099-X'); expect(render(output, 0).text).toContain('CASE-00100-X'); expect(render(output, 1).text).not.toContain('CASE');
    expect((await inspectPageDecorations(buffer(output))).decorations[0].pages).toEqual([3, 1]);
    const preview = await applyPageDecorations(original, [{ type: 'create', definition }], { previewPage: 1 }); expect(render(preview, 0).text).toContain('CASE-00100-X'); expect(render(preview, 2).pixels).toEqual(render(original, 2).pixels);
  });
  it('restores image bytes from native resources, then updates and removes the image', async () => {
    const original = await source(), definition = watermark(); definition.content = { type: 'image', name: 'test.png', data: image(), width: 80, height: 40 };
    const output = await applyPageDecorations(original, [{ type: 'create', definition }]);
    const item = (await inspectPageDecorations(buffer(output))).decorations[0]; expect(item.managed).toBe(true);
    expect(item.definition.kind === 'watermark' && item.definition.content.type === 'image' && item.definition.content.data.byteLength).toBeGreaterThan(0);
    const updated = await applyPageDecorations(buffer(output), [{ type: 'update', id: item.id, definition: item.definition }]); expect(render(updated).pixels).toEqual(render(output).pixels);
    const removed = await applyPageDecorations(buffer(updated), [{ type: 'remove', id: item.id }]); expect(render(removed).pixels).toEqual(render(original).pixels);
  });
  it('keeps shared resources and marks manageable after copying a page subset with new object numbers', async () => {
    const marked = await applyPageDecorations(await source(3), [{ type: 'create', definition: footer() }]), from = await PDFDocument.load(marked), to = await PDFDocument.create();
    for (const page of await copyPagesWithForms(to, from, [2, 0])) to.addPage(page);
    const copied = await to.save(), item = (await inspectPageDecorations(buffer(copied))).decorations[0];
    expect(item.managed, item.reason).toBe(true); expect(item.needsRefresh).toBe(true); expect(item.pages).toEqual([2, 1]);
    const refreshed = await applyPageDecorations(buffer(copied), [{ type: 'update', id: item.id, definition: item.definition }]); expect(render(refreshed, 0).text).toContain('Page 5/2');
  });
  it('refuses conflicting duplicated instances and changed resources instead of deleting content', async () => {
    const marked = await applyPageDecorations(await source(), [{ type: 'create', definition: watermark() }]);
    const changed = await mutate(marked, document => { const page = document.loadPage(0), object = page.getObject(), contents = object.get('Contents'); try { for (let n = 0; n < contents.length; n++) { const stream = contents.get(n), manifest = stream.get(MARK.manifest); try { if (manifest.isString()) stream.writeStream('q\nQ\n'); } finally { manifest.destroy(); stream.destroy(); } } } finally { contents.destroy(); object.destroy(); page.destroy(); } });
    const item = (await inspectPageDecorations(buffer(changed))).decorations[0]; expect(item.managed).toBe(false); await expect(applyPageDecorations(buffer(changed), [{ type: 'remove', id: item.id }])).rejects.toThrow(/changed/);
    const from = await PDFDocument.load(marked), to = await PDFDocument.create(); for (const page of await to.copyPages(from, [0, 0])) to.addPage(page);
    const duplicate = (await inspectPageDecorations(buffer(await to.save()))).decorations[0]; expect(duplicate.managed).toBe(false); expect(duplicate.reason).toMatch(/conflict/);
  });
  it('rejects signed and XFA documents and cancels atomically between pages', async () => {
    const original = await source(3), controller = new AbortController(), copy = original.slice(0);
    await expect(applyPageDecorations(original, [{ type: 'create', definition: watermark([1, 2, 3]) }], { signal: controller.signal, onProgress: progress => { if (progress.completed === 1) controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' }); expect(new Uint8Array(original)).toEqual(new Uint8Array(copy));
    const xfaBytes = await mutate(new Uint8Array(original), document => { const trailer = document.getTrailer(), form = trailer.get('Root', 'AcroForm'), value = document.newString('unsupported'); try { form.put('XFA', value); } finally { value.destroy(); form.destroy(); trailer.destroy(); } }); const xfa = buffer(xfaBytes); expect((await inspectPageDecorations(xfa)).canEdit).toBe(false); await expect(applyPageDecorations(xfa, [{ type: 'create', definition: watermark() }])).rejects.toThrow(/XFA/);
    const signed = await mutate(new Uint8Array(original), document => { const trailer = document.getTrailer(), catalog = trailer.get('Root'); try { catalog.put('Perms', { DocMDP: { ByteRange: [0, 1, 2, 3] } }); } finally { catalog.destroy(); trailer.destroy(); } }); await expect(applyPageDecorations(buffer(signed), [{ type: 'create', definition: watermark() }])).rejects.toThrow(/Signed/);
  });
  it('layers foreground and background independently and restores the previous decoration when one is removed', async () => {
    const original = await source(), text = watermark(); text.opacity = 1;
    const background = { kind: 'background' as const, name: 'Paper', pages: [1], opacity: 0.5, fill: { type: 'color' as const, color: '#FF0000' } };
    const marked = await applyPageDecorations(original, [{ type: 'create', definition: text }]);
    const both = await applyPageDecorations(buffer(marked), [{ type: 'create', definition: background }]);
    const output = render(both), sample = (x: number, y: number) => [...output.pixels.slice((y * output.width + x) * 3, (y * output.width + x) * 3 + 3)];
    expect(sample(1, 1)[0]).toBe(255); expect(sample(1, 1)[1]).toBeGreaterThan(120); expect(sample(1, 1)[1]).toBeLessThan(135); expect(sample(25, 365)).toEqual([0, 0, 0]);
    const items = (await inspectPageDecorations(buffer(both))).decorations; expect(items.every(item => item.managed)).toBe(true);
    const removed = await applyPageDecorations(buffer(both), [{ type: 'remove', id: items.find(item => item.definition.kind === 'background')!.id }]); expect(render(removed).pixels).toEqual(render(marked).pixels);
  });
  it.each(['contain', 'cover', 'stretch'] as const)('preserves image background %s on a rotated page across reopening', async fit => {
    const original = await source(1, 90, 2), output = await applyPageDecorations(original, [{ type: 'create', definition: { kind: 'background', name: 'Image paper', pages: [1], opacity: 0.7, fill: { type: 'image', name: 'image.png', data: image(), fit } } }]);
    const item = (await inspectPageDecorations(buffer(output))).decorations[0]; expect(item.managed, item.reason).toBe(true);
    const again = await applyPageDecorations(buffer(output), [{ type: 'update', id: item.id, definition: item.definition }]); expect(render(again).pixels).toEqual(render(output).pixels);
    const removed = await applyPageDecorations(buffer(again), [{ type: 'remove', id: item.id }]); expect(render(removed).pixels).toEqual(render(original).pixels);
  });
  it('isolates original content transformations from foreground placement', async () => {
    const original = await source(), transformed = await mutate(new Uint8Array(original), document => { const page = document.loadPage(0), object = page.getObject(), contents = object.get('Contents'), stream = document.addStream('2 0 0 2 70 60 cm\n', {}); try { contents.push(stream); } finally { stream.destroy(); contents.destroy(); object.destroy(); page.destroy(); } });
    const definition = watermark(), normal = await applyPageDecorations(original, [{ type: 'create', definition }]), output = await applyPageDecorations(buffer(transformed), [{ type: 'create', definition }]);
    expect(render(output).pixels).toEqual(render(normal).pixels);
    const item = (await inspectPageDecorations(buffer(output))).decorations[0]; const removed = await applyPageDecorations(buffer(output), [{ type: 'remove', id: item.id }]); expect(render(removed).pixels).toEqual(render(transformed).pixels);
  });
  it('does not restore stale management metadata if a content rewrite removes the dedicated wrapper', async () => {
    const marked = await applyPageDecorations(await source(), [{ type: 'create', definition: watermark() }]);
    const rewritten = await mutate(marked, document => { const page = document.loadPage(0), object = page.getObject(), contents = object.get('Contents'); try { for (let n = 0; n < contents.length; n++) { const stream = contents.get(n); try { stream.delete(MARK.manifest); } finally { stream.destroy(); } } } finally { contents.destroy(); object.destroy(); page.destroy(); } });
    const item = (await inspectPageDecorations(buffer(rewritten))).decorations[0]; expect(item.managed).toBe(false); expect(render(rewritten).text).toContain('SECRET WATERMARK'); await expect(applyPageDecorations(buffer(rewritten), [{ type: 'remove', id: item.id }])).rejects.toThrow(/cannot be changed safely/);
  });
  it('validates the whole operation batch before publishing any changes', async () => {
    const original = await source(), before = new Uint8Array(original.slice(0)), invalid = watermark(); invalid.pages = [2];
    await expect(applyPageDecorations(original, [{ type: 'create', definition: watermark() }, { type: 'create', definition: invalid }])).rejects.toThrow(/Page number/); expect(new Uint8Array(original)).toEqual(before);
    invalid.pages = [1]; invalid.position.offsetX = 14000;
    await expect(applyPageDecorations(original, [{ type: 'create', definition: watermark() }, { type: 'create', definition: invalid }])).rejects.toThrow(/does not fit/); expect(new Uint8Array(original)).toEqual(before);
  });
  it('detects merged image decorations with the same ID and settings but different native images', async () => {
    const definition = watermark([1, 2]); definition.content = { type: 'image', name: 'same.png', data: image(), width: 80, height: 40 };
    const first = await applyPageDecorations(await source(2), [{ type: 'create', definition }]);
    const item = (await inspectPageDecorations(buffer(first))).decorations[0];
    const bitmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 10], false); let alternate: Uint8Array;
    try { bitmap.getPixels().fill(20); alternate = new Uint8Array(bitmap.asPNG()); } finally { bitmap.destroy(); }
    definition.content.data = alternate;
    const second = await applyPageDecorations(buffer(first), [{ type: 'update', id: item.id, definition }]);
    const merged = await PDFDocument.create(), firstSource = await PDFDocument.load(first), secondSource = await PDFDocument.load(second);
    for (const page of await merged.copyPages(firstSource, [0])) merged.addPage(page);
    for (const page of await merged.copyPages(secondSource, [1])) merged.addPage(page);
    const conflicting = (await inspectPageDecorations(buffer(await merged.save()))).decorations[0]; expect(conflicting.managed).toBe(false); expect(conflicting.reason).toMatch(/conflict/);
  });
  it('keeps the original stacking slot when updating overlapping foreground and background marks', async () => {
    const original = await source();
    const a = { kind: 'background' as const, name: 'Red', pages: [1], opacity: 1, fill: { type: 'color' as const, color: '#FF0000' } }, b = { ...a, name: 'Blue', fill: { type: 'color' as const, color: '#0000FF' } };
    const foreground = watermark(), marked = await applyPageDecorations(original, [{ type: 'create', definition: a }, { type: 'create', definition: b }, { type: 'create', definition: foreground }, { type: 'create', definition: { ...foreground, name: 'Second foreground', opacity: 1 } }]);
    const items = (await inspectPageDecorations(buffer(marked))).decorations;
    const updated = await applyPageDecorations(buffer(marked), items.filter(item => item.definition.name === 'Red' || item.definition.name === 'Draft').reverse().map(item => ({ type: 'update', id: item.id, definition: { ...item.definition, name: `Renamed ${item.definition.name}` } })));
    expect(render(updated).pixels).toEqual(render(marked).pixels);
  });
  it('detects changed full geometry and reports current bounds after a 180-degree rotation', async () => {
    const definition = watermark(); definition.position = { anchor: 'top-left', offsetX: 10, offsetY: 12 };
    const marked = await applyPageDecorations(await source(), [{ type: 'create', definition }]), before = (await inspectPageDecorations(buffer(marked))).decorations[0].placements[0].bounds;
    const document = await PDFDocument.load(marked); document.getPage(0).setRotation(degrees(180)); const rotated = await document.save(), inspection = await inspectPageDecorations(buffer(rotated)), item = inspection.decorations[0];
    expect(item.needsRefresh).toBe(true); expect(item.managed).toBe(true);
    expect(item.placements[0].bounds.x).toBeCloseTo(inspection.pages[0].width - before.x - before.width, 3); expect(item.placements[0].bounds.y).toBeCloseTo(inspection.pages[0].height - before.y - before.height, 3);
    const refreshed = await applyPageDecorations(buffer(rotated), [{ type: 'update', id: item.id, definition: item.definition }]); expect((await inspectPageDecorations(buffer(refreshed))).decorations[0].needsRefresh).toBe(false);
  });
  it.each(['form', 'opacity'])('refuses deletion if other page content uses an escaped %s resource name', async kind => {
    const marked = await applyPageDecorations(await source(), [{ type: 'create', definition: watermark() }]);
    const shared = await mutate(marked, document => { const page = document.loadPage(0), object = page.getObject(), contents = object.get('Contents'); try {
      for (let n = 0; n < contents.length; n++) { const stream = contents.get(n), meta = stream.get(MARK.manifest); try { if (meta.isString()) { const manifest = JSON.parse(meta.asString()), name = (kind === 'form' ? manifest.resources[0].name : manifest.gsName).replace('PDE_', 'PDE#5f'); const extra = document.addStream(`q\n(ignored)/${name} ${kind === 'form' ? 'Do' : 'gs'}\nQ\n`, {}); try { contents.push(extra); } finally { extra.destroy(); } break; } } finally { meta.destroy(); stream.destroy(); } }
    } finally { contents.destroy(); object.destroy(); page.destroy(); } });
    const item = (await inspectPageDecorations(buffer(shared))).decorations[0]; expect(item.managed).toBe(false); expect(item.reason).toMatch(/other page content/); await expect(applyPageDecorations(buffer(shared), [{ type: 'remove', id: item.id }])).rejects.toThrow(/other page content/);
  });
  it('returns a safe readonly placeholder for incomplete or malformed manifest definitions', async () => {
    const marked = await applyPageDecorations(await source(), [{ type: 'create', definition: watermark() }]);
    const malformed = await mutate(marked, document => { const page = document.loadPage(0), object = page.getObject(), contents = object.get('Contents'); try { for (let n = 0; n < contents.length; n++) { const stream = contents.get(n), meta = stream.get(MARK.manifest); try { if (meta.isString()) { const manifest = JSON.parse(meta.asString()); manifest.definition = { kind: 'watermark', name: 'Broken', pages: [1], opacity: 1 }; const string = document.newString(JSON.stringify(manifest)); try { stream.put(MARK.manifest, string); } finally { string.destroy(); } } } finally { meta.destroy(); stream.destroy(); } } } finally { contents.destroy(); object.destroy(); page.destroy(); } });
    const items = (await inspectPageDecorations(buffer(malformed))).decorations; expect(items.length).toBeGreaterThan(0); for (const item of items) { expect(item.managed).toBe(false); expect(item.definition.kind === 'watermark' && item.definition.content.type).toBe('text'); }
  });
  it('checks reachable signatures without resolving legitimate free xref entries', async () => {
    const original = await source(), sparse = await mutate(new Uint8Array(original), document => { const orphan = document.addObject({ Unreachable: 1 }); orphan.destroy(); const page = document.loadPage(0), object = page.getObject(), contents = object.get('Contents'), stream = document.addStream('q\nQ\n', {}); try { contents.push(stream); } finally { stream.destroy(); contents.destroy(); object.destroy(); page.destroy(); } });
    const messages: string[] = []; mupdf.setLog(message => messages.push(message));
    try { const inspected = await inspectPageDecorations(buffer(sparse)); expect(inspected.canEdit).toBe(true); expect(messages).toEqual([]); }
    finally { mupdf.setLog(null); }
  });
  it.each([['form', false], ['form', true], ['opacity', false], ['opacity', true]] as const)('protects borrowed %s resources in external Forms (nested: %s)', async (kind, nested) => {
    const blank = await PDFDocument.create(); blank.addPage([200, 300]);
    const marked = await applyPageDecorations(buffer(await blank.save()), [{ type: 'create', definition: { kind: 'background', name: 'Owned', pages: [1], opacity: kind === 'opacity' ? 0.5 : 1, fill: { type: 'color', color: '#FF0000' } } }]);
    const document = new mupdf.PDFDocument(marked), page = document.loadPage(0), object = page.getObject(), contents = object.get('Contents'), forms = object.get('Resources', 'XObject');
    let shared: Uint8Array, externalOnly: Uint8Array;
    try {
      let wrapperIndex = -1, name = '';
      for (let index = 0; index < contents.length; index++) { const stream = contents.get(index), raw = stream.get(MARK.manifest); try { if (raw.isString()) { const manifest = JSON.parse(raw.asString()); wrapperIndex = index; name = kind === 'form' ? manifest.resources[0].name : manifest.gsName; } } finally { raw.destroy(); stream.destroy(); } }
      const borrowed = name.replace('PDE_', 'PDE#5f');
      const leaf = document.addStream(kind === 'form' ? `q /${borrowed} Do Q` : `q /${borrowed} gs 0 0 1 rg 0 0 200 300 re f Q`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 300] });
      try { forms.put('ExternalLeaf', leaf); } finally { leaf.destroy(); }
      if (nested) { const parent = document.addStream('q /ExternalLeaf Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 300] }); try { forms.put('ExternalParent', parent); } finally { parent.destroy(); } }
      const call = document.addStream(`q /${nested ? 'ExternalParent' : 'ExternalLeaf'} Do Q`, {}); try { contents.push(call); } finally { call.destroy(); }
      const saved = document.saveToBuffer('garbage=1,compress'); try { shared = new Uint8Array(saved.asUint8Array()); } finally { saved.destroy(); }
      // Independently prove the external content needs the borrowed resource:
      // hide only the owned wrapper, retaining the resources used by that Form.
      const control = document.newArray();
      try { for (let index = 0; index < contents.length; index++) { if (index === wrapperIndex) continue; const stream = contents.get(index); try { control.push(stream); } finally { stream.destroy(); } } object.put('Contents', control); }
      finally { control.destroy(); }
      const savedControl = document.saveToBuffer('garbage=1,compress'); try { externalOnly = new Uint8Array(savedControl.asUint8Array()); } finally { savedControl.destroy(); }
    } finally { forms.destroy(); contents.destroy(); object.destroy(); page.destroy(); document.destroy(); }
    const pixel = [...render(externalOnly).pixels.slice(0, 3)];
    if (kind === 'form') expect(pixel).toEqual([255, 0, 0]); else { expect(pixel[2]).toBe(255); expect(pixel[0]).toBeGreaterThan(120); expect(pixel[0]).toBeLessThan(135); }
    const item = (await inspectPageDecorations(buffer(shared))).decorations[0]; expect(item.managed).toBe(false); expect(item.reason).toMatch(/external Form with inherited/);
    await expect(applyPageDecorations(buffer(shared), [{ type: 'remove', id: item.id }])).rejects.toThrow(/external Form with inherited/);
  });
});
