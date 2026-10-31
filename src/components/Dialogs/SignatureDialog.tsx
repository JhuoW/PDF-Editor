import { ErrorMessage } from '../Feedback/ErrorMessage';
import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t } from "../../i18n";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PendingImageData } from '../Toolbar/CombinedToolbar';
import { createDrawnSignature, paintSignature, readSignatureImage, SIGNATURE_LIMITS, SIGNATURE_PAD, type SignaturePoint, type SignatureStroke } from './signatureImage';
import './SignatureDialog.css';

export interface SignatureDialogProps { documentKey: unknown; revision: number; onInsert: (image: PendingImageData) => void; onClose: () => void }
export function SignatureDialog(props: SignatureDialogProps) {
  useLocale();
  const [session, setSession] = useState({ documentKey: props.documentKey, revision: props.revision, sequence: 0 });
  if (!Object.is(session.documentKey, props.documentKey) || session.revision !== props.revision) {
    setSession({ documentKey: props.documentKey, revision: props.revision, sequence: session.sequence + 1 }); return null;
  }
  return <SignatureSession key={session.sequence} onInsert={props.onInsert} onClose={props.onClose} />;
}
function SignatureSession({ onInsert, onClose }: Pick<SignatureDialogProps, 'onInsert' | 'onClose'>) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), pad = useRef<HTMLCanvasElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const active = useRef(true), submitted = useRef(false), upload = useRef<AbortController | null>(null), file = useRef<File | null>(null);
  const pointer = useRef<{ id: number; stroke: SignatureStroke } | null>(null);
  const [mode, setMode] = useState<'draw' | 'upload'>('draw'), [strokes, setStrokes] = useState<SignatureStroke[]>([]), [current, setCurrent] = useState<SignatureStroke | null>(null);
  const [color, setColor] = useState('#111111'), [width, setWidth] = useState(3), [removeWhite, setRemoveWhite] = useState(false);
  const [image, setImage] = useState<PendingImageData | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    active.current = true;
    const element = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => { active.current = false; upload.current?.abort(); element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useLayoutEffect(() => {
    const canvas = pad.current, context = canvas?.getContext('2d'); if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height); context.save(); context.scale(2, 2);
    paintSignature(context, current ? [...strokes, current] : strokes); context.restore();
  }, [strokes, current, mode]);
  const close = () => { active.current = false; upload.current?.abort(); onClose(); };
  const changeMode = (value: 'draw' | 'upload') => { if (pointer.current) return; upload.current?.abort(); setBusy(false); setError(null); setMode(value); };
  const point = (event: ReactPointerEvent): SignaturePoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(SIGNATURE_PAD.width, (event.clientX - bounds.left) * SIGNATURE_PAD.width / bounds.width)), y: Math.max(0, Math.min(SIGNATURE_PAD.height, (event.clientY - bounds.top) * SIGNATURE_PAD.height / bounds.height)) };
  };
  const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointer.current || event.button !== 0) return;
    if (strokes.length >= SIGNATURE_LIMITS.strokes || strokes.reduce((count, stroke) => count + stroke.points.length, 0) >= SIGNATURE_LIMITS.points) { setError('This signature is too detailed. Undo a stroke or clear it before continuing.'); return; }
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    const stroke = { points: [point(event)], color, width }; pointer.current = { id: event.pointerId, stroke }; setCurrent(stroke); setError(null);
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = pointer.current; if (!gesture || gesture.id !== event.pointerId) return;
    event.preventDefault();
    if (strokes.reduce((count, stroke) => count + stroke.points.length, 0) + gesture.stroke.points.length >= SIGNATURE_LIMITS.points) { setError('This signature is too detailed. Undo a stroke or clear it before continuing.'); return; }
    const next = point(event), previous = gesture.stroke.points.at(-1)!;
    if (Math.hypot(next.x - previous.x, next.y - previous.y) < .5) return;
    gesture.stroke = { ...gesture.stroke, points: [...gesture.stroke.points, next] }; setCurrent(gesture.stroke);
  };
  const finish = (event: ReactPointerEvent<HTMLCanvasElement>, cancel = false) => {
    const gesture = pointer.current; if (!gesture || gesture.id !== event.pointerId) return;
    if (!cancel) { move(event); setStrokes(previous => [...previous, gesture.stroke]); }
    pointer.current = null; setCurrent(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const load = async (selected: File, eraseWhite = removeWhite) => {
    upload.current?.abort(); const request = new AbortController(); upload.current = request; file.current = selected;
    setBusy(true); setImage(null); setError(null);
    try { const result = await readSignatureImage(selected, eraseWhite, request.signal); if (active.current && !request.signal.aborted) setImage(result); }
    catch (cause) { if (active.current && !request.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not read the signature image.'); }
    finally { if (active.current && !request.signal.aborted) setBusy(false); }
  };
  const insert = () => {
    if (submitted.current || !active.current || busy || current || (mode === 'draw' ? !strokes.length : !image)) return;
    submitted.current = true;
    try { onInsert(mode === 'draw' ? createDrawnSignature(strokes) : image!); close(); }
    catch (cause) { submitted.current = false; setError(cause instanceof Error ? cause.message : 'Could not prepare the signature.'); }
  };
  return <dialog ref={dialog} className="signature-dialog" aria-labelledby="signature-title" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}>
    <header><div><h2 id="signature-title">{t("m.signature.2f32be")}</h2><p>{t("m.draw.your.signature.or.choose.an.image.then.clic.7a54c5")}</p></div><div className="dialog-language"><LanguageSwitcher /></div><button type="button" aria-label={t("m.close.signature.affa64")} onClick={close}>×</button></header>
    <div className="signature-body">
      <div className="signature-modes" role="group" aria-label={t("m.signature.source.57f2af")}><button type="button" aria-pressed={mode === 'draw'} disabled={!!current} onClick={() => changeMode('draw')}>{t("m.draw.bfa50c")}</button><button type="button" aria-pressed={mode === 'upload'} disabled={!!current} onClick={() => changeMode('upload')}>{t("m.upload.image.f35dec")}</button></div>
      {mode === 'draw' ? <>
        <div className="signature-tools"><label>{t("m.pen.color.7536be")}<select value={color} disabled={!!current} onChange={event => setColor(event.target.value)}><option value="#111111">{t("m.black.b406fb")}</option><option value="#174ea6">{t("m.blue.7d44bc")}</option><option value="#b91c1c">{t("m.red.cc9db3")}</option></select></label><label>{t("m.pen.width.a5b69f")}<select value={width} disabled={!!current} onChange={event => setWidth(Number(event.target.value))}><option value="2">{t("m.fine.226d7e")}</option><option value="3">{t("m.medium.d40496")}</option><option value="5">{t("m.bold.19e074")}</option></select></label><button type="button" disabled={!strokes.length || !!current} onClick={() => { setStrokes(previous => previous.slice(0, -1)); setError(null); }}>{t("m.undo.stroke.5c0ee9")}</button><button type="button" disabled={!strokes.length || !!current} onClick={() => { setStrokes([]); setError(null); }}>{t("m.clear.719ea3")}</button></div>
        <canvas ref={pad} className="signature-pad" width={SIGNATURE_PAD.width * 2} height={SIGNATURE_PAD.height * 2} tabIndex={0} aria-label={t("m.draw.your.signature.01a499")} onPointerDown={begin} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)} />
        <p className="signature-help">{t("m.use.a.mouse.pen.or.touch.empty.space.is.trimmed..f0cb18")}</p>
      </> : <>
        <label className="signature-upload">{t("m.signature.image.b3b945")}<input ref={fileInput} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; if (selected) void load(selected); }} /></label>
        <label className="signature-check"><input type="checkbox" checked={removeWhite} onChange={event => { setRemoveWhite(event.target.checked); if (file.current) void load(file.current, event.target.checked); }} />{t("m.remove.white.background.ddcba0")}</label>
        <p className="signature-help">{t("m.png.or.jpeg.up.to.5.mb.and.12.megapixels.the.pre.b30210")}</p>
        <div className="signature-image-preview" aria-busy={busy}>{busy ? <p role="status">{t("m.preparing.signature.970c8f")}</p> : image ? <img src={image.imageData} alt={t("m.signature.preview.48fe3c")} /> : <p>{t("m.choose.a.signature.image.to.preview.it.here.a96038")}</p>}</div>
      </>}
      {error && <p className="signature-error" role="alert"><ErrorMessage error={error} /></p>}
      <p className="signature-help">{t("m.this.adds.a.visible.signature.image.it.does.not..6070df")}</p>
    </div>
    <footer><button type="button" onClick={close}>{t("m.cancel.77dfd2")}</button><button type="button" className="signature-primary" disabled={busy || !!current || (mode === 'draw' ? !strokes.length : !image)} onClick={insert}>{t("m.place.signature.681560")}</button></footer>
  </dialog>;
}
export default SignatureDialog;
