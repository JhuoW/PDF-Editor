import { useEffect } from 'react';
import { t, useLocale } from '../../i18n';
import { TEXT_LAYOUT_FONTS } from '../../editing/TextLayout';
import type { FontAsset } from '../../fonts/fontAsset';
import { refreshFontLibrary, useFontLibraryStore } from '../../store/fontLibraryStore';
import { useFontManagerStore } from '../../store/fontManagerStore';
import { useDocumentStore } from '../../store/documentStore';
import './FontManager.css';

export function TextFontPicker({ value, asset, onChange }: { value?: string; asset?: FontAsset; onChange: (name?: string, asset?: FontAsset) => void }) {
  useLocale();
  const fonts = useFontLibraryStore(state => state.fonts);
  useEffect(() => { void refreshFontLibrary().catch(() => {}); }, []);
  const available = asset && !fonts.some(font => font.id === asset.id) ? [...fonts, asset] : fonts;
  return <div className="text-font-picker">
    <label>{t('m.font.b97c4d')}<select aria-label={t('text.format.font')} value={value ?? 'original'} onChange={event => {
      const name = event.target.value;
      onChange(name === 'original' ? undefined : name, available.find(font => font.id === name));
    }}>
      <option value="original">{t('m.original.pdf.font.0d4133')}</option>
      <optgroup label={t('fonts.chinese')}><option value="zh-Hans">{t('fonts.builtin')}</option></optgroup>
      {!!available.length && <optgroup label={t('fonts.imported')}>{available.map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</optgroup>}
      <optgroup label={t('fonts.standard')}>{TEXT_LAYOUT_FONTS.map(font => <option key={font} value={font}>{font}</option>)}</optgroup>
    </select></label>
    <button type="button" className="font-manage-button" onClick={() => useFontManagerStore.setState({ request: { document: useDocumentStore.getState().document, choose: font => onChange(font.id, font) } })}>{t('fonts.manage')}</button>
    {value && (value === 'zh-Hans' || value.startsWith('custom:')) && <p className="font-help">{t('fonts.styles')}</p>}
  </div>;
}
