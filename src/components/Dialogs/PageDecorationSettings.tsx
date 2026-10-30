import { useLocale, t, translateMessage } from "../../i18n";
import { useEffect, useRef, useState } from 'react';
import type { DecorationAnchor, DecorationFontFamily, HeaderFooterSlot, PageDecorationDefinition } from '../../core/PageDecorationTypes';
import { IMAGE_LIMITS, validateImageCollection, type PDFImageInput } from '../../core/ImagePDF';
import { DecorationNumberInput as NumberInput } from './DecorationNumberInput';
import { formatDecorationPages, parseDecorationPages } from './decorationDraft';

interface Props {
  value: PageDecorationDefinition; totalPages: number; disabled: boolean; otherImages: PDFImageInput[];
  onChange: (value: PageDecorationDefinition) => void; onValidity: (error: string | null) => void;
  onImageBusy: (busy: boolean) => void; onError: (error: string | null) => void;
}
const anchors: Array<[DecorationAnchor, string]> = [['top-left', 'Top left'], ['top-center', 'Top center'], ['top-right', 'Top right'], ['center-left', 'Center left'], ['center', 'Center'], ['center-right', 'Center right'], ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom center'], ['bottom-right', 'Bottom right']];
const slots: Array<[HeaderFooterSlot, string]> = [['headerLeft', 'Header left'], ['headerCenter', 'Header center'], ['headerRight', 'Header right'], ['footerLeft', 'Footer left'], ['footerCenter', 'Footer center'], ['footerRight', 'Footer right']];
function Font({ value, onChange }: { value: DecorationFontFamily; onChange: (value: DecorationFontFamily) => void }) {
  useLocale();
  return <label>{t("m.font.b97c4d")}<select value={value} onChange={event => onChange(event.target.value as DecorationFontFamily)}><option value="Helvetica">{t("m.sans.serif.ecc39d")}</option><option value="Times">{t("m.serif.a5c78a")}</option><option value="Courier">{t("m.monospace.216fcd")}</option></select></label>;
}

export function PageDecorationSettings({ value, totalPages, disabled, otherImages, onChange, onValidity, onImageBusy, onError }: Props) {
  useLocale();
  const [range, setRange] = useState(formatDecorationPages(value.pages));
  const [parity, setParity] = useState<'all' | 'odd' | 'even'>('all');
  const active = useRef(false), reading = useRef(false), slotFocus = useRef<HeaderFooterSlot>('footerCenter');
  const slotInputs = useRef<Partial<Record<HeaderFooterSlot, HTMLInputElement | null>>>({});
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const setPages = (text: string, filter: typeof parity) => {
    setRange(text); setParity(filter);
    try {
      const pages = parseDecorationPages(text, totalPages, filter); onValidity(null);
      if (pages.join(',') !== value.pages.join(',')) onChange({ ...value, pages });
    } catch (cause) { onValidity(cause instanceof Error ? cause.message : 'Invalid page range.'); }
  };
  const chooseImage = async (file: File | undefined) => {
    if (!file || reading.current || disabled) return;
    reading.current = true; onImageBusy(true); onError(null);
    try {
      if (!file.size || file.size > IMAGE_LIMITS.bytesPerFile || otherImages.reduce((sum, image) => sum + image.data.byteLength, 0) + file.size > IMAGE_LIMITS.totalBytes) throw new Error('Choose a PNG or JPEG of at most 40 MB; decoration images together must not exceed 150 MB.');
      const data = new Uint8Array(await file.arrayBuffer());
      if (!active.current) return;
      const information = validateImageCollection([...otherImages, { name: file.name, data }]).at(-1)!;
      if (value.kind === 'watermark') {
        const width = information.orientation >= 5 ? information.height : information.width;
        const height = information.orientation >= 5 ? information.width : information.height;
        const targetWidth = Math.min(180, 180 * width / height), targetHeight = targetWidth * height / width;
        onChange({ ...value, content: { type: 'image', name: file.name, data, width: targetWidth, height: targetHeight } });
      } else if (value.kind === 'background') onChange({ ...value, fill: { type: 'image', name: file.name, data, fit: value.fill.type === 'image' ? value.fill.fit : 'contain' } });
    } catch (cause) { if (active.current) onError(cause instanceof Error ? cause.message : 'Could not read the image.'); }
    finally { reading.current = false; if (active.current) onImageBusy(false); }
  };
  const imageInput = (label: string, name: string, data: Uint8Array) => <>
    <label>{translateMessage(label)}<input type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void chooseImage(file); }} /></label>
    {name && <p className="decoration-image-summary">{name} · {(data.byteLength / 1024).toFixed(1)}{' '}{t("m.kib.ca54b0")}</p>}
    <p className="decoration-help">{t("m.still.png.or.jpeg.up.to.40.mb.and.40.megapixels..2f97ad")}</p>
  </>;
  const token = (text: string) => {
    if (value.kind !== 'header-footer') return;
    const slot = slotFocus.current, input = slotInputs.current[slot], old = value.slots[slot] ?? '';
    const start = input?.selectionStart ?? old.length, end = input?.selectionEnd ?? old.length;
    onChange({ ...value, slots: { ...value.slots, [slot]: old.slice(0, start) + text + old.slice(end) } });
    requestAnimationFrame(() => { if (active.current && input?.isConnected) { input.focus({ preventScroll: true }); input.setSelectionRange(start + text.length, start + text.length); } });
  };
  return <fieldset disabled={disabled}>
    <legend>{t("m.decoration.settings.117b91")}</legend>
    <label>{t("m.name.709a23")}<input value={value.name} onChange={event => onChange({ ...value, name: event.target.value })} /></label>
    <label>{t("m.pages.600584")}<input value={range} placeholder="1, 3-5" onChange={event => setPages(event.target.value, parity)} /></label>
    <label>{t("m.page.filter.9271a8")}<select value={parity} onChange={event => setPages(range, event.target.value as typeof parity)}><option value="all">{t("m.all.selected.pages.10d0bf")}</option><option value="odd">{t("m.odd.pages.only.a777be")}</option><option value="even">{t("m.even.pages.only.dc6bcb")}</option></select></label>
    <p className="decoration-help">{value.pages.length}{' '}{t("m.selected.835f3b")}{' '}{value.pages.length === 1 ? t("m.page.767013") : t("m.pages.eec654")}{t("m.positions.and.sizes.use.pdf.points.on.the.displa.af1c74")}</p>
    <NumberInput label={t("m.opacity.28dd90")} value={Math.round(value.opacity * 100)} min={0} max={100} onChange={opacity => onChange({ ...value, opacity: opacity / 100 })} />
    {value.kind !== 'background' && <label>{t("m.layer.434363")}<select value={value.layer} onChange={event => onChange({ ...value, layer: event.target.value as 'foreground' | 'background' })}><option value="foreground">{t("m.in.front.of.page.content.f75888")}</option><option value="background">{t("m.behind.page.content.634aa0")}</option></select></label>}
    {value.kind === 'watermark' && (() => {
      const content = value.content;
      return <>
        <label>{t("m.watermark.type.5f3331")}<select value={content.type} onChange={event => onChange({ ...value, content: event.target.value === 'text' ? { type: 'text', text: 'DRAFT', fontFamily: 'Helvetica', fontSize: 48, color: '#666666' } : { type: 'image', name: '', data: new Uint8Array(), width: 180, height: 120 } })}><option value="text">{t("m.text.c3328c")}</option><option value="image">{t("m.image.50e19f")}</option></select></label>
        {content.type === 'text' ? <>
          <label>{t("m.watermark.text.ecf870")}<textarea rows={3} maxLength={4096} value={content.text} onChange={event => onChange({ ...value, content: { ...content, text: event.target.value } })} /></label>
          <div className="decoration-grid"><Font value={content.fontFamily} onChange={fontFamily => onChange({ ...value, content: { ...content, fontFamily } })} /><NumberInput label={t("m.font.size.83ca9e")} value={content.fontSize} min={1} max={500} onChange={fontSize => onChange({ ...value, content: { ...content, fontSize } })} /></div>
          <label>{t("m.text.color.1c7a30")}<input type="color" value={content.color} onChange={event => onChange({ ...value, content: { ...content, color: event.target.value } })} /></label>
        </> : <>
          {imageInput('Watermark image', content.name, content.data)}
          <div className="decoration-grid"><NumberInput label={t("m.image.width.f2cccb")} value={content.width} min={1} max={14400} onChange={width => onChange({ ...value, content: { ...content, width } })} /><NumberInput label={t("m.image.height.d500aa")} value={content.height} min={1} max={14400} onChange={height => onChange({ ...value, content: { ...content, height } })} /></div>
        </>}
        <label>{t("m.position.cf1c85")}<select value={value.position.anchor} onChange={event => onChange({ ...value, position: { ...value.position, anchor: event.target.value as DecorationAnchor } })}>{anchors.map(([key, label]) => <option key={key} value={key}>{translateMessage(label)}</option>)}</select></label>
        <div className="decoration-grid"><NumberInput label={t("m.horizontal.offset.2cfb8a")} value={value.position.offsetX} min={-14400} max={14400} onChange={offsetX => onChange({ ...value, position: { ...value.position, offsetX } })} /><NumberInput label={t("m.vertical.offset.669530")} value={value.position.offsetY} min={-14400} max={14400} onChange={offsetY => onChange({ ...value, position: { ...value.position, offsetY } })} /></div>
        <NumberInput label={t("m.rotation.clockwise.degrees.117d0a")} value={value.angle} min={-360} max={360} onChange={angle => onChange({ ...value, angle })} />
      </>;
    })()}
    {value.kind === 'header-footer' && <>
      <p className="decoration-help">{t("m.select.a.header.or.footer.then.insert.a.page.or..5d80d9")}</p>
      <div className="decoration-token-actions">{['{page}', '{pages}', '{bates}'].map(text => <button type="button" key={text} onPointerDown={event => event.preventDefault()} onClick={() => token(text)}>{t("m.insert.95802d")}{' '}{text}</button>)}</div>
      {slots.map(([key, label]) => <label key={key}>{translateMessage(label)}<input ref={element => { slotInputs.current[key] = element; }} maxLength={4096} value={value.slots[key] ?? ''} onFocus={() => { slotFocus.current = key; }} onChange={event => onChange({ ...value, slots: { ...value.slots, [key]: event.target.value } })} /></label>)}
      <div className="decoration-grid"><Font value={value.fontFamily} onChange={fontFamily => onChange({ ...value, fontFamily })} /><NumberInput label={t("m.font.size.83ca9e")} value={value.fontSize} min={1} max={500} onChange={fontSize => onChange({ ...value, fontSize })} /></div>
      <label>{t("m.text.color.1c7a30")}<input type="color" value={value.color} onChange={event => onChange({ ...value, color: event.target.value })} /></label>
      <div className="decoration-grid"><NumberInput label={t("m.side.margin.fd652a")} value={value.marginX} max={14400} onChange={marginX => onChange({ ...value, marginX })} /><NumberInput label={t("m.top.margin.47923f")} value={value.marginTop} max={14400} onChange={marginTop => onChange({ ...value, marginTop })} /><NumberInput label={t("m.bottom.margin.0ec594")} value={value.marginBottom} max={14400} onChange={marginBottom => onChange({ ...value, marginBottom })} /><NumberInput label={t("m.starting.page.number.4fd23c")} value={value.pageNumberStart} min={0} max={999999999} step={1} onChange={pageNumberStart => onChange({ ...value, pageNumberStart })} /></div>
      <p className="decoration-help">{t("m.page.2f99c0")}{' '}{t("m.uses.the.document.page.number.plus.this.starting.583a63")}{' '}{t("m.pages.56d30d")}{' '}{t("m.is.the.document.s.total.pages.61f655")}</p>
      <fieldset><legend>{t("m.bates.numbering.96021b")}</legend><div className="decoration-grid">
        <NumberInput label={t("m.bates.starting.number.c96fc1")} value={value.bates.start} min={0} max={999999999} step={1} onChange={start => onChange({ ...value, bates: { ...value.bates, start } })} />
        <NumberInput label={t("m.bates.digits.9ccb2e")} value={value.bates.digits} min={1} max={16} step={1} onChange={digits => onChange({ ...value, bates: { ...value.bates, digits } })} />
        <label>{t("m.bates.prefix.ce60f2")}<input value={value.bates.prefix} onChange={event => onChange({ ...value, bates: { ...value.bates, prefix: event.target.value } })} /></label>
        <label>{t("m.bates.suffix.e72a43")}<input value={value.bates.suffix} onChange={event => onChange({ ...value, bates: { ...value.bates, suffix: event.target.value } })} /></label>
      </div><p className="decoration-help">{t("m.bates.numbers.advance.only.across.the.selected.p.3770a4")}</p></fieldset>
    </>}
    {value.kind === 'background' && <>
      <label>{t("m.background.type.602839")}<select value={value.fill.type} onChange={event => onChange({ ...value, fill: event.target.value === 'color' ? { type: 'color', color: '#f0f4ff' } : { type: 'image', name: '', data: new Uint8Array(), fit: 'contain' } })}><option value="color">{t("m.solid.color.2f6c1d")}</option><option value="image">{t("m.image.50e19f")}</option></select></label>
      {value.fill.type === 'color' ? <label>{t("m.background.color.1a0371")}<input type="color" value={value.fill.color} onChange={event => onChange({ ...value, fill: { type: 'color', color: event.target.value } })} /></label> : (() => { const fill = value.fill; return <>
        {imageInput('Background image', fill.name, fill.data)}
        <label>{t("m.image.fit.0fb139")}<select value={fill.fit} onChange={event => onChange({ ...value, fill: { ...fill, fit: event.target.value as 'contain' | 'cover' | 'stretch' } })}><option value="contain">{t("m.fit.whole.image.4d6376")}</option><option value="cover">{t("m.fill.page.crop.edges.0963fe")}</option><option value="stretch">{t("m.stretch.to.page.2115b0")}</option></select></label>
      </>; })()}
      <p className="decoration-help">{t("m.backgrounds.appear.behind.existing.page.content..642473")}</p>
    </>}
  </fieldset>;
}
