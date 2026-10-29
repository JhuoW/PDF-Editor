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
  return <label>Font<select value={value} onChange={event => onChange(event.target.value as DecorationFontFamily)}><option value="Helvetica">Sans serif</option><option value="Times">Serif</option><option value="Courier">Monospace</option></select></label>;
}

export function PageDecorationSettings({ value, totalPages, disabled, otherImages, onChange, onValidity, onImageBusy, onError }: Props) {
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
    <label>{label}<input type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void chooseImage(file); }} /></label>
    {name && <p className="decoration-image-summary">{name} · {(data.byteLength / 1024).toFixed(1)} KiB</p>}
    <p className="decoration-help">Still PNG or JPEG, up to 40 MB and 40 megapixels per image.</p>
  </>;
  const token = (text: string) => {
    if (value.kind !== 'header-footer') return;
    const slot = slotFocus.current, input = slotInputs.current[slot], old = value.slots[slot] ?? '';
    const start = input?.selectionStart ?? old.length, end = input?.selectionEnd ?? old.length;
    onChange({ ...value, slots: { ...value.slots, [slot]: old.slice(0, start) + text + old.slice(end) } });
    requestAnimationFrame(() => { if (active.current && input?.isConnected) { input.focus({ preventScroll: true }); input.setSelectionRange(start + text.length, start + text.length); } });
  };
  return <fieldset disabled={disabled}>
    <legend>Decoration settings</legend>
    <label>Name<input value={value.name} onChange={event => onChange({ ...value, name: event.target.value })} /></label>
    <label>Pages<input value={range} placeholder="1, 3-5" onChange={event => setPages(event.target.value, parity)} /></label>
    <label>Page filter<select value={parity} onChange={event => setPages(range, event.target.value as typeof parity)}><option value="all">All selected pages</option><option value="odd">Odd pages only</option><option value="even">Even pages only</option></select></label>
    <p className="decoration-help">{value.pages.length} selected {value.pages.length === 1 ? 'page' : 'pages'}. Positions and sizes use PDF points on the displayed page.</p>
    <NumberInput label="Opacity (%)" value={Math.round(value.opacity * 100)} min={0} max={100} onChange={opacity => onChange({ ...value, opacity: opacity / 100 })} />
    {value.kind !== 'background' && <label>Layer<select value={value.layer} onChange={event => onChange({ ...value, layer: event.target.value as 'foreground' | 'background' })}><option value="foreground">In front of page content</option><option value="background">Behind page content</option></select></label>}
    {value.kind === 'watermark' && (() => {
      const content = value.content;
      return <>
        <label>Watermark type<select value={content.type} onChange={event => onChange({ ...value, content: event.target.value === 'text' ? { type: 'text', text: 'DRAFT', fontFamily: 'Helvetica', fontSize: 48, color: '#666666' } : { type: 'image', name: '', data: new Uint8Array(), width: 180, height: 120 } })}><option value="text">Text</option><option value="image">Image</option></select></label>
        {content.type === 'text' ? <>
          <label>Watermark text<textarea rows={3} maxLength={4096} value={content.text} onChange={event => onChange({ ...value, content: { ...content, text: event.target.value } })} /></label>
          <div className="decoration-grid"><Font value={content.fontFamily} onChange={fontFamily => onChange({ ...value, content: { ...content, fontFamily } })} /><NumberInput label="Font size" value={content.fontSize} min={1} max={500} onChange={fontSize => onChange({ ...value, content: { ...content, fontSize } })} /></div>
          <label>Text color<input type="color" value={content.color} onChange={event => onChange({ ...value, content: { ...content, color: event.target.value } })} /></label>
        </> : <>
          {imageInput('Watermark image', content.name, content.data)}
          <div className="decoration-grid"><NumberInput label="Image width" value={content.width} min={1} max={14400} onChange={width => onChange({ ...value, content: { ...content, width } })} /><NumberInput label="Image height" value={content.height} min={1} max={14400} onChange={height => onChange({ ...value, content: { ...content, height } })} /></div>
        </>}
        <label>Position<select value={value.position.anchor} onChange={event => onChange({ ...value, position: { ...value.position, anchor: event.target.value as DecorationAnchor } })}>{anchors.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <div className="decoration-grid"><NumberInput label="Horizontal offset" value={value.position.offsetX} min={-14400} max={14400} onChange={offsetX => onChange({ ...value, position: { ...value.position, offsetX } })} /><NumberInput label="Vertical offset" value={value.position.offsetY} min={-14400} max={14400} onChange={offsetY => onChange({ ...value, position: { ...value.position, offsetY } })} /></div>
        <NumberInput label="Rotation (clockwise degrees)" value={value.angle} min={-360} max={360} onChange={angle => onChange({ ...value, angle })} />
      </>;
    })()}
    {value.kind === 'header-footer' && <>
      <p className="decoration-help">Select a header or footer, then insert a page or Bates token at the cursor.</p>
      <div className="decoration-token-actions">{['{page}', '{pages}', '{bates}'].map(text => <button type="button" key={text} onPointerDown={event => event.preventDefault()} onClick={() => token(text)}>Insert {text}</button>)}</div>
      {slots.map(([key, label]) => <label key={key}>{label}<input ref={element => { slotInputs.current[key] = element; }} maxLength={4096} value={value.slots[key] ?? ''} onFocus={() => { slotFocus.current = key; }} onChange={event => onChange({ ...value, slots: { ...value.slots, [key]: event.target.value } })} /></label>)}
      <div className="decoration-grid"><Font value={value.fontFamily} onChange={fontFamily => onChange({ ...value, fontFamily })} /><NumberInput label="Font size" value={value.fontSize} min={1} max={500} onChange={fontSize => onChange({ ...value, fontSize })} /></div>
      <label>Text color<input type="color" value={value.color} onChange={event => onChange({ ...value, color: event.target.value })} /></label>
      <div className="decoration-grid"><NumberInput label="Side margin" value={value.marginX} max={14400} onChange={marginX => onChange({ ...value, marginX })} /><NumberInput label="Top margin" value={value.marginTop} max={14400} onChange={marginTop => onChange({ ...value, marginTop })} /><NumberInput label="Bottom margin" value={value.marginBottom} max={14400} onChange={marginBottom => onChange({ ...value, marginBottom })} /><NumberInput label="Starting page number" value={value.pageNumberStart} min={0} max={999999999} step={1} onChange={pageNumberStart => onChange({ ...value, pageNumberStart })} /></div>
      <p className="decoration-help">{'{page}'} uses the document page number plus this starting offset. {'{pages}'} is the document's total pages.</p>
      <fieldset><legend>Bates numbering</legend><div className="decoration-grid">
        <NumberInput label="Bates starting number" value={value.bates.start} min={0} max={999999999} step={1} onChange={start => onChange({ ...value, bates: { ...value.bates, start } })} />
        <NumberInput label="Bates digits" value={value.bates.digits} min={1} max={16} step={1} onChange={digits => onChange({ ...value, bates: { ...value.bates, digits } })} />
        <label>Bates prefix<input value={value.bates.prefix} onChange={event => onChange({ ...value, bates: { ...value.bates, prefix: event.target.value } })} /></label>
        <label>Bates suffix<input value={value.bates.suffix} onChange={event => onChange({ ...value, bates: { ...value.bates, suffix: event.target.value } })} /></label>
      </div><p className="decoration-help">Bates numbers advance only across the selected pages, in the listed order.</p></fieldset>
    </>}
    {value.kind === 'background' && <>
      <label>Background type<select value={value.fill.type} onChange={event => onChange({ ...value, fill: event.target.value === 'color' ? { type: 'color', color: '#f0f4ff' } : { type: 'image', name: '', data: new Uint8Array(), fit: 'contain' } })}><option value="color">Solid color</option><option value="image">Image</option></select></label>
      {value.fill.type === 'color' ? <label>Background color<input type="color" value={value.fill.color} onChange={event => onChange({ ...value, fill: { type: 'color', color: event.target.value } })} /></label> : (() => { const fill = value.fill; return <>
        {imageInput('Background image', fill.name, fill.data)}
        <label>Image fit<select value={fill.fit} onChange={event => onChange({ ...value, fill: { ...fill, fit: event.target.value as 'contain' | 'cover' | 'stretch' } })}><option value="contain">Fit whole image</option><option value="cover">Fill page, crop edges</option><option value="stretch">Stretch to page</option></select></label>
      </>; })()}
      <p className="decoration-help">Backgrounds appear behind existing page content. Opaque content can cover them.</p>
    </>}
  </fieldset>;
}
