import { useEffect } from 'react';
import { Languages } from 'lucide-react';
import { t, useLocale, useLocaleStore } from '../../i18n';

export function LanguageSwitcher() {
  const locale = useLocale(), setLocale = useLocaleStore(state => state.setLocale);
  useEffect(() => { document.documentElement.lang = locale; document.title = t("m.pdf.editor.3bb8b8"); }, [locale]);
  return <div className="language-switcher" role="group" aria-label={t('Language')} data-testid="language-switcher" onKeyDown={event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); setLocale(event.key === 'ArrowLeft' ? 'zh-CN' : 'en'); }
  }}>
    <Languages size={15} aria-hidden="true" />
    <button type="button" lang="zh-CN" data-i18n-autonym aria-label={t('Use Chinese')} aria-pressed={locale === 'zh-CN'} onPointerDown={event => event.preventDefault()} onClick={() => setLocale('zh-CN')}>中文</button>
    <button type="button" lang="en" data-i18n-autonym aria-label={t('Use English')} aria-pressed={locale === 'en'} onPointerDown={event => event.preventDefault()} onClick={() => setLocale('en')}>English</button>
  </div>;
}
