import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { t, useLocale } from '../../i18n';
import { updateHistory, type UpdateRecord } from '../../data/updateHistory';
import { LanguageSwitcher } from '../Workspace/LanguageSwitcher';
import './UpdateHistoryDialog.css';

export function UpdateHistoryDialog({ onClose }: { onClose: () => void }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), content = useRef<HTMLDivElement>(null);
  const id = useId(), [expanded, setExpanded] = useState(false);
  const [latest, ...earlier] = updateHistory;
  useEffect(() => {
    const element = dialog.current, opener = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const entry = (update: UpdateRecord, recent = false) => <article className="update-history-entry" key={update.id} aria-labelledby={`${id}-${update.id}`}>
    <div className="update-history-date">
      <h3 id={`${id}-${update.id}`}><time dateTime={update.updatedAt}>{update.updatedAt.slice(0, 16).replace('T', ' ')}</time></h3>
      {recent && <span className="update-history-latest">{t('updates.latest')}</span>}
    </div>
    <ul>{update.changes.map(key => <li key={key}>{t(key)}</li>)}</ul>
  </article>;
  return <dialog ref={dialog} className="update-history-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-timezone`}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault();
    }}>
    <header>
      <h2 id={`${id}-title`}>{t('updates.title')}</h2>
      <LanguageSwitcher />
      <button type="button" className="update-history-close" aria-label={t('updates.close')} onClick={onClose}><X size={18} aria-hidden="true" /></button>
      <p id={`${id}-timezone`}>{t('updates.timezone')}</p>
    </header>
    <div ref={content} className="update-history-content" tabIndex={0}>
      {entry(latest, true)}
      <section id={`${id}-earlier`} hidden={!expanded} aria-label={t('updates.earlier')}>
        <h3 className="update-history-section-title">{t('updates.earlier')}</h3>
        {earlier.map(update => entry(update))}
      </section>
    </div>
    <footer>
      {earlier.length > 0 && <button type="button" className="update-history-toggle" aria-expanded={expanded} aria-controls={`${id}-earlier`}
        onClick={() => { setExpanded(value => !value); if (expanded && content.current) content.current.scrollTop = 0; }}>
        <ChevronDown size={16} aria-hidden="true" />{t(expanded ? 'updates.less' : 'updates.more', { count: earlier.length })}
      </button>}
      <button type="button" className="update-history-done" onClick={onClose}>{t('updates.done')}</button>
    </footer>
  </dialog>;
}
