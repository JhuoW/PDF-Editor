import { useEffect, useId, useRef, useState } from 'react';
import { t, useLocale } from '../../i18n';
import { ErrorMessage } from '../Feedback/ErrorMessage';
import { fontLibrary, importFontFile } from '../../fonts/fontLibrary';
import type { FontAsset } from '../../fonts/fontAsset';
import { publishFontLibrary, refreshFontLibrary, useFontLibraryStore } from '../../store/fontLibraryStore';

export function FontManagerDialog({ onClose, onChoose }: { onClose: () => void; onChoose: (font: FontAsset) => void }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), file = useRef<HTMLInputElement>(null), request = useRef<AbortController | null>(null);
  const fonts = useFontLibraryStore(state => state.fonts), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), id = useId();
  useEffect(() => {
    const element = dialog.current, opener = document.activeElement;
    let live = true;
    element?.showModal();
    void refreshFontLibrary().catch(cause => { if (live) setError(cause); });
    return () => { live = false; request.current?.abort(); element?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  const update = async (operation: (signal: AbortSignal) => Promise<FontAsset[]>) => {
    if (busy) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try { const next = await operation(controller.signal); if (!controller.signal.aborted) publishFontLibrary(next); }
    catch (cause) { if (!controller.signal.aborted) setError(cause); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <dialog ref={dialog} className="font-manager-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault(); }} onClick={event => event.stopPropagation()}>
    <header><h2 id={`${id}-title`}>{t('fonts.manage')}</h2><button type="button" aria-label={t('m.close.esc.6ae84e')} onClick={onClose}>×</button></header>
    <div className="font-manager-content">
      <p>{t('fonts.help')}</p>
      <input ref={file} type="file" accept=".ttf,.otf" hidden aria-label={t('fonts.import')} onChange={event => {
        const selected = event.target.files?.[0]; event.target.value = '';
        if (selected) void update(async signal => {
          const asset = await importFontFile(selected, signal);
          if (signal.aborted) throw new DOMException('Font import cancelled.', 'AbortError');
          return fontLibrary({ add: asset });
        });
      }} />
      <button type="button" disabled={busy} onClick={() => file.current?.click()}>{t(busy ? 'fonts.loading' : 'fonts.import')}</button>
      {error != null && <div role="alert"><ErrorMessage error={error} operation="Import font" /></div>}
      {!fonts.length && <p className="font-help">{t('fonts.empty')}</p>}
      <ul className="font-library-list">{fonts.map(font => <li key={font.id}>
        <div><strong>{font.name}</strong><small>{t('fonts.file', { file: font.fileName, size: (font.data.byteLength / 1024 / 1024).toFixed(1) })}</small><small>{t(font.chinese ? 'fonts.coverage.chinese' : 'fonts.coverage.partial')}</small></div>
        <div className="font-library-actions"><button type="button" disabled={busy} onClick={() => onChoose(font)}>{t('fonts.use')}</button>
          <button type="button" disabled={busy} aria-label={t('fonts.removeNamed', { name: font.name })} onClick={() => void update(() => fontLibrary({ remove: font.id }))}>{t('fonts.remove')}</button></div>
      </li>)}</ul>
      <p className="font-help">{t('fonts.removeHelp')}</p>
    </div>
  </dialog>;
}
