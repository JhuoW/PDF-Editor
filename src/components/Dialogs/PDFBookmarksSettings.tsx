import { PDF_BOOKMARK_LIMITS, type PDFBookmarkDefinition, type PDFBookmarkInspection } from '../../core/PDFBookmarksTypes';
import type { PDFLinkTarget, PDFLinkView } from '../../core/PDFLinkTypes';
import { DecorationNumberInput } from './DecorationNumberInput';
import { fitLinkRect } from './pdfLinksDraft';
interface Props { definition: PDFBookmarkDefinition; pages: PDFBookmarkInspection['pages']; currentPage: number; disabled: boolean; onChange: (definition: PDFBookmarkDefinition) => void; onNumericDraft: (label: string, dirty: boolean) => void }
const views: Array<[PDFLinkView, string]> = [['Fit', 'Fit page'], ['XYZ', 'Position and zoom'], ['FitB', 'Fit page content'], ['FitH', 'Fit width'], ['FitBH', 'Fit content width'], ['FitV', 'Fit height'], ['FitBV', 'Fit content height'], ['FitR', 'Fit rectangle']];
export function PDFBookmarksSettings({ definition, pages, currentPage, disabled, onChange, onNumericDraft }: Props) {
  const target = definition.target, destination = pages.find(page => page.pageNumber === (target?.type === 'page' ? target.pageNumber : currentPage)) ?? pages[0];
  const change = (patch: Partial<PDFBookmarkDefinition>) => onChange({ ...definition, ...patch });
  const number = (label: string, value: number, onChange: (value: number) => void, max: number, min = 0) => <DecorationNumberInput label={label} value={value} onChange={onChange} min={min} max={max} onDraftChange={dirty => onNumericDraft(label, dirty)} />;
  const changeTarget = (patch: Partial<Extract<PDFLinkTarget, { type: 'page' }>>) => { if (target?.type === 'page') change({ target: { ...target, ...patch } }); };
  const coordinate = (axis: 'x' | 'y') => target?.type === 'page' && <div>
    <label className="bookmark-check"><input type="checkbox" checked={target[axis] == null} onChange={event => { onNumericDraft(`Destination ${axis.toUpperCase()}`, false); changeTarget({ [axis]: event.target.checked ? null : 0 }); }} />Keep current {axis.toUpperCase()}</label>
    {target[axis] != null && number(`Destination ${axis.toUpperCase()}`, target[axis], value => changeTarget({ [axis]: value }), axis === 'x' ? destination.width : destination.height)}
  </div>;
  return <fieldset disabled={disabled}>
    <label>Title<input maxLength={PDF_BOOKMARK_LIMITS.titleCharacters} value={definition.title} onChange={event => change({ title: event.target.value })} /></label>
    <div className="bookmark-style"><label className="bookmark-check"><input type="checkbox" checked={definition.bold} onChange={event => change({ bold: event.target.checked })} />Bold</label><label className="bookmark-check"><input type="checkbox" checked={definition.italic} onChange={event => change({ italic: event.target.checked })} />Italic</label><label>Title color<input type="color" value={definition.color} onChange={event => change({ color: event.target.value })} /></label></div>
    <label className="bookmark-check"><input type="checkbox" checked={definition.expanded} onChange={event => change({ expanded: event.target.checked })} />Initially expanded</label>
    <label>Destination type<select value={target?.type ?? 'group'} onChange={event => change({ target: event.target.value === 'group' ? null : event.target.value === 'url' ? { type: 'url', url: 'https://' } : { type: 'page', pageNumber: currentPage, view: 'Fit' } })}><option value="page">Internal page</option><option value="url">Website or email</option><option value="group">Group without a destination</option></select></label>
    {target?.type === 'url' && <><label>URL<input inputMode="url" maxLength={4096} value={target.url} placeholder="https://example.com or mailto:name@example.com" onChange={event => change({ target: { type: 'url', url: event.target.value } })} /></label><p className="bookmark-help">Use http://, https:// or mailto:. Preview never opens this address.</p></>}
    {target?.type === 'page' && <>
      <label>Destination page<select value={target.pageNumber} onChange={event => { const next = pages.find(page => page.pageNumber === Number(event.target.value))!; changeTarget({ pageNumber: next.pageNumber, ...(target.x == null ? {} : { x: Math.min(target.x, next.width) }), ...(target.y == null ? {} : { y: Math.min(target.y, next.height) }), ...(target.rect ? { rect: fitLinkRect(target.rect, next.width, next.height) } : {}) }); }}>{pages.map(page => <option key={page.pageNumber} value={page.pageNumber}>Page {page.pageNumber}</option>)}</select></label>
      <label>Destination view<select value={target.view} onChange={event => { const view = event.target.value as PDFLinkView; change({ target: { type: 'page', pageNumber: target.pageNumber, view, ...(view === 'XYZ' ? { x: target.x ?? null, y: target.y ?? null, zoom: target.zoom ?? null } : view === 'FitH' || view === 'FitBH' ? { y: target.y ?? null } : view === 'FitV' || view === 'FitBV' ? { x: target.x ?? null } : view === 'FitR' ? { rect: target.rect ?? { x: 0, y: 0, width: destination.width, height: destination.height } } : {}) } }); }}>{views.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {(target.view === 'XYZ' || target.view === 'FitV' || target.view === 'FitBV') && coordinate('x')}
      {(target.view === 'XYZ' || target.view === 'FitH' || target.view === 'FitBH') && coordinate('y')}
      {target.view === 'XYZ' && <><label className="bookmark-check"><input type="checkbox" checked={target.zoom == null} onChange={event => { onNumericDraft('Destination zoom (%)', false); changeTarget({ zoom: event.target.checked ? null : 1 }); }} />Keep current zoom</label>{target.zoom != null && number('Destination zoom (%)', target.zoom * 100, value => changeTarget({ zoom: value / 100 }), 6400, 1)}</>}
      {target.view === 'FitR' && target.rect && <div className="bookmark-numbers">
        {number('Destination X', target.rect.x, x => changeTarget({ rect: { ...target.rect!, x } }), destination.width - target.rect.width)}
        {number('Destination Y', target.rect.y, y => changeTarget({ rect: { ...target.rect!, y } }), destination.height - target.rect.height)}
        {number('Destination width', target.rect.width, width => changeTarget({ rect: { ...target.rect!, width } }), destination.width - target.rect.x, 1)}
        {number('Destination height', target.rect.height, height => changeTarget({ rect: { ...target.rect!, height } }), destination.height - target.rect.y, 1)}
      </div>}
      <p className="bookmark-help">Positions are points from the unrotated page’s top-left corner. The page preview includes current edits.</p>
    </>}
    {!target && <p className="bookmark-help">This bookmark groups its children and does not navigate to a page.</p>}
  </fieldset>;
}
