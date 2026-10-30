import { useLocale, translateMessage, t } from "../../i18n";
import { PDF_LINK_LIMITS, type PDFLinkDefinition, type PDFLinkInspection, type PDFLinkTarget, type PDFLinkView } from '../../core/PDFLinkTypes';
import { DecorationNumberInput } from './DecorationNumberInput';
import { fitLinkRect } from './pdfLinksDraft';
interface Props {
  definition: PDFLinkDefinition; pages: PDFLinkInspection['pages']; disabled: boolean;
  onChange: (definition: PDFLinkDefinition) => void; onNumericDraft: (label: string, dirty: boolean) => void;
}
const views: Array<[PDFLinkView, string]> = [['Fit', 'Fit page'], ['XYZ', 'Position and zoom'], ['FitB', 'Fit page content'], ['FitH', 'Fit width'], ['FitBH', 'Fit content width'], ['FitV', 'Fit height'], ['FitBV', 'Fit content height'], ['FitR', 'Fit rectangle']];
export function PDFLinksSettings({ definition, pages, disabled, onChange, onNumericDraft }: Props) {
  useLocale();
  const page = pages.find(item => item.pageNumber === definition.pageNumber), target = definition.target;
  const destination = pages.find(item => item.pageNumber === (target.type === 'page' ? target.pageNumber : 1)) ?? pages[0];
  const change = (patch: Partial<PDFLinkDefinition>) => onChange({ ...definition, ...patch });
  const number = (label: string, value: number, onChange: (value: number) => void, min = 0, max = 14400, step: number | 'any' = 'any') => <DecorationNumberInput label={translateMessage(label)} value={value} onChange={onChange} min={min} max={max} step={step} onDraftChange={dirty => onNumericDraft(label, dirty)} />;
  const changeTarget = (patch: Partial<Extract<PDFLinkTarget, { type: 'page' }>>) => { if (target.type === 'page') change({ target: { ...target, ...patch } }); };
  const coordinate = (axis: 'x' | 'y') => target.type === 'page' && <div key={axis}>
    <label className="pdf-links-check"><input type="checkbox" checked={target[axis] == null} onChange={event => { onNumericDraft(`Destination ${axis.toUpperCase()}`, false); changeTarget({ [axis]: event.target.checked ? null : 0 }); }} />{t("m.keep.current.786906")}{' '}{axis.toUpperCase()}</label>
    {target[axis] != null && number(`Destination ${axis.toUpperCase()}`, target[axis], value => changeTarget({ [axis]: value }), 0, axis === 'x' ? destination.width : destination.height)}
  </div>;
  if (!page || !destination) return <p className="pdf-links-warning">{t("m.this.link.does.not.have.a.valid.page.location.949d5a")}</p>;
  const border = definition.border ?? { width: 0, color: '#000000', style: 'solid' as const };
  return <fieldset disabled={disabled}>
    <label>{t("m.description.55f8eb")}<input maxLength={PDF_LINK_LIMITS.descriptionCharacters} value={definition.description ?? ''} onChange={event => change({ description: event.target.value })} /></label>
    <h3>{t("m.clickable.area.4afaa7")}</h3>
    <label>{t("m.link.page.d42e5e")}<select value={definition.pageNumber} onChange={event => { const next = pages.find(item => item.pageNumber === Number(event.target.value))!; change({ pageNumber: next.pageNumber, rect: fitLinkRect(definition.rect, next.width, next.height) }); }}>{pages.map(item => <option key={item.pageNumber} value={item.pageNumber}>{t("m.page.fb0627")}{' '}{item.pageNumber}</option>)}</select></label>
    <div className="pdf-links-numbers">
      {number('X', definition.rect.x, x => change({ rect: { ...definition.rect, x } }), 0, page.width - definition.rect.width)}
      {number('Y', definition.rect.y, y => change({ rect: { ...definition.rect, y } }), 0, page.height - definition.rect.height)}
      {number('Width', definition.rect.width, width => change({ rect: { ...definition.rect, width } }), 1, page.width - definition.rect.x)}
      {number('Height', definition.rect.height, height => change({ rect: { ...definition.rect, height } }), 1, page.height - definition.rect.y)}
    </div>
    <p className="pdf-links-help">{t("m.coordinates.are.points.from.the.unrotated.page.s.db8d5f")}</p>
    <h3>{t("m.destination.d42713")}</h3>
    <label>{t("m.link.type.545778")}<select value={target.type} onChange={event => { onChange({ ...definition, target: event.target.value === 'url' ? { type: 'url', url: 'https://' } : { type: 'page', pageNumber: definition.pageNumber, view: 'Fit' } }); }}><option value="url">{t("m.external.url.83c33c")}</option><option value="page">{t("m.internal.page.71564e")}</option></select></label>
    {target.type === 'url' ? <><label>{t("m.url.0e2d9b")}<input type="text" inputMode="url" maxLength={PDF_LINK_LIMITS.urlCharacters} value={target.url} placeholder={t("m.https.example.com.or.mailto.name.example.com.a83a26")} onChange={event => change({ target: { type: 'url', url: event.target.value } })} /></label><p className="pdf-links-help">{t("m.use.an.absolute.https.http.or.mailto.address.lin.9bd136")}</p></> : <>
      <label>{t("m.destination.page.e4220c")}<select value={target.pageNumber} onChange={event => {
        const next = pages.find(item => item.pageNumber === Number(event.target.value))!;
        changeTarget({ pageNumber: next.pageNumber, ...(target.x == null ? {} : { x: Math.min(target.x, next.width) }), ...(target.y == null ? {} : { y: Math.min(target.y, next.height) }), ...(target.rect ? { rect: fitLinkRect(target.rect, next.width, next.height) } : {}) });
      }}>{pages.map(item => <option key={item.pageNumber} value={item.pageNumber}>{t("m.page.fb0627")}{' '}{item.pageNumber}</option>)}</select></label>
      <label>{t("m.destination.view.a2ce63")}<select value={target.view} onChange={event => {
        const view = event.target.value as PDFLinkView;
        change({ target: { type: 'page', pageNumber: target.pageNumber, view, ...(view === 'XYZ' ? { x: target.x ?? null, y: target.y ?? null, zoom: target.zoom ?? null } : view === 'FitH' || view === 'FitBH' ? { y: target.y ?? null } : view === 'FitV' || view === 'FitBV' ? { x: target.x ?? null } : view === 'FitR' ? { rect: target.rect ?? { x: 0, y: 0, width: destination.width, height: destination.height } } : {}) } });
      }}>{views.map(([value, label]) => <option key={value} value={value}>{translateMessage(label)}</option>)}</select></label>
      {(target.view === 'XYZ' || target.view === 'FitV' || target.view === 'FitBV') && coordinate('x')}
      {(target.view === 'XYZ' || target.view === 'FitH' || target.view === 'FitBH') && coordinate('y')}
      {target.view === 'XYZ' && <><label className="pdf-links-check"><input type="checkbox" checked={target.zoom == null} onChange={event => { onNumericDraft('Destination zoom (%)', false); changeTarget({ zoom: event.target.checked ? null : 1 }); }} />{t("m.keep.current.zoom.25d603")}</label>{target.zoom != null && number('Destination zoom (%)', target.zoom * 100, value => changeTarget({ zoom: value / 100 }), 1, 6400)}</>}
      {target.view === 'FitR' && target.rect && <div className="pdf-links-numbers">
        {number('Destination X', target.rect.x, x => changeTarget({ rect: { ...target.rect!, x } }), 0, destination.width - target.rect.width)}
        {number('Destination Y', target.rect.y, y => changeTarget({ rect: { ...target.rect!, y } }), 0, destination.height - target.rect.height)}
        {number('Destination width', target.rect.width, width => changeTarget({ rect: { ...target.rect!, width } }), 1, destination.width - target.rect.x)}
        {number('Destination height', target.rect.height, height => changeTarget({ rect: { ...target.rect!, height } }), 1, destination.height - target.rect.y)}
      </div>}
    </>}
    <h3>{t("m.border.5d10d3")}</h3><label>{t("m.border.style.e29480")}<select value={border.style} onChange={event => change({ border: { ...border, style: event.target.value as typeof border.style } })}><option value="solid">{t("m.solid.d00635")}</option><option value="dashed">{t("m.dashed.7b0a09")}</option><option value="underline">{t("m.underline.39773a")}</option></select></label>
    <div className="pdf-links-numbers">{number('Border width', border.width, width => change({ border: { ...border, width } }), 0, PDF_LINK_LIMITS.borderWidth)}<label>{t("m.border.color.06186d")}<input type="color" value={border.color} onChange={event => change({ border: { ...border, color: event.target.value } })} /></label></div>
    <p className="pdf-links-help">{t("m.a.border.width.of.0.makes.the.clickable.area.inv.5c4b5c")}</p>
  </fieldset>;
}
