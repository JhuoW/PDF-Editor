import { useId, useState } from 'react';
import { t, translateError, useLocale } from '../../i18n';
import { diagnosticText, errorText } from '../../utils/diagnostics';
import './Feedback.css';

/** Localized summary with the unchanged technical cause available on demand. */
export function ErrorMessage({ error, operation = 'Editor' }: { error: unknown; operation?: string }) {
  const locale = useLocale(), id = useId();
  const [expanded, setExpanded] = useState(false), [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  if (!errorText(error)) return null;
  return <span className="diagnostic-message">
    <span className="diagnostic-summary">{translateError(error)}</span>{' '}
    <button type="button" className="diagnostic-link" aria-expanded={expanded} aria-controls={id} onClick={event => { event.stopPropagation(); setExpanded(value => !value); setCopied(null); }}>{t('diagnostics.details')}</button>
    {expanded && <span id={id} className="diagnostic-details">
      <code tabIndex={0}>{errorText(error)}</code>
      <button type="button" onClick={event => { event.stopPropagation();
        void (async () => { try { await navigator.clipboard.writeText(diagnosticText(error, operation, locale)); setCopied('yes'); } catch { setCopied('failed'); } })();
      }}>{t('diagnostics.copy')}</button>
      {copied && <span role="status">{t(copied === 'yes' ? 'diagnostics.copied' : 'diagnostics.copyFailed')}</span>}
    </span>}
  </span>;
}
