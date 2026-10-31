import { t, useLocale } from '../../i18n';
import type { TextFontInfo } from '../../editing/TextCheckTypes';
export function TextFontSummary({ fonts }: { fonts?: TextFontInfo }) {
  useLocale();
  if (!fonts) return <p role="status">{t('text.font.checking')}</p>;
  return <div className="text-font-summary" aria-label={t('text.font.details')}>
    <dl><dt>{t('text.font.source')}</dt><dd>{fonts.original.join(', ')}</dd>
      <dt>{t('text.font.used')}</dt><dd>{fonts.used.join(', ') || t('text.font.empty')}</dd></dl>
    <p className={fonts.mode === 'fallback' ? 'font-fallback' : ''}>{t(`text.font.mode.${fonts.mode}`)}</p>
  </div>;
}
