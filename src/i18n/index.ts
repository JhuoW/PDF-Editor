import { en } from './en';
import { zhCN } from './zh-CN';
import { useLocaleStore } from './locale';
import { templateOptions } from './templateOptions';
export { useLocale, useLocaleStore } from './locale';
export type { Locale } from './locale';

export type MessageKey = keyof typeof en;
const english = en as Record<string, string>;
const chinese = zhCN as Record<string, string>;
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const sourceKeys = new Map(Object.entries(english).map(([key, value]) => [normalize(value), key]));
const sourceKeysLower = new Map(Object.entries(english).map(([key, value]) => [normalize(value).toLowerCase(), key]));
const patterns = Object.entries(english).filter(([, value]) => /\{v\d+\}/.test(value)).map(([key, value]) => {
  const names: string[] = [];
  const pattern = normalize(value).split(/(\{v\d+\})/g).map(part => {
    if (/^\{v\d+\}$/.test(part)) {
      const name = part.slice(1, -1);
      names.push(name);
      return templateOptions[key]?.[name] === 'number' ? '(-?\\d+(?:\\.\\d+)?)' : '([\\s\\S]*?)';
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { key, names, pattern: new RegExp(`^${pattern}$`, 'i'), weight: value.replace(/\{v\d+\}/g, '').length };
}).sort((a, b) => b.weight - a.weight);

export function t(key: string, values: Record<string, unknown> = {}): string {
  const resolved = Object.hasOwn(english, key) ? key : sourceKeys.get(normalize(key));
  const source = resolved ? english[resolved] : key;
  const translated = useLocaleStore.getState().locale === 'zh-CN' && resolved ? chinese[resolved] : source;
  return (translated ?? source).replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(values, name) || values[name] === undefined) return match;
    if (useLocaleStore.getState().locale !== 'zh-CN' || !resolved) return String(values[name]);
    const kind = templateOptions[resolved]?.[name];
    if (kind === 'plural') return '';
    if (kind === 'error') return translateError(values[name]);
    if (kind === 'message') return translateMessage(values[name]);
    return String(values[name]);
  });
}
/** Localize application status/error protocols at presentation, preserving stored state and user data. */
export function translateMessage(value: unknown): string {
  if (value === null || value === undefined) return '';
  const source = value instanceof Error ? value.message : String(value);
  if (useLocaleStore.getState().locale === 'en') return source;
  const normalized = normalize(source), direct = Object.hasOwn(english, normalized) ? normalized : sourceKeys.get(normalized) ?? sourceKeysLower.get(normalized.toLowerCase());
  if (direct) return t(direct);
  for (const item of patterns) {
    if (!item.weight) continue;
    const match = item.pattern.exec(normalized); if (!match) continue;
    const values = Object.fromEntries(item.names.map((name, index) => [name, match[index + 1]]));
    return t(item.key, values);
  }
  return source;
}
export function translateError(value: unknown): string {
  const source = value instanceof Error ? value.message : String(value ?? '');
  if (source.includes('\n')) return source.split('\n').map(line => translateError(line)).join('\n');
  const translated = translateMessage(source);
  if (useLocaleStore.getState().locale === 'zh-CN' && /[A-Za-z]{3}/.test(translated) && translated === source) {
    return t('An unexpected error occurred. Please try again.');
  }
  return translated;
}
export function currentLocale(): string { return useLocaleStore.getState().locale === 'zh-CN' ? 'zh-CN' : 'en-US'; }
