/** PDF readers infer spaces from glyph distances. Editor-authored justification
 * must distinguish those visual gaps from the whitespace the user entered. This
 * metadata stores whitespace offsets only, and cannot restore removed letters. */
export interface TextRowSpacing { length: number; spaces: Array<{ offset: number; text: string }> }
const PREFIX = 'PDFEditorSpacing_';
const MAX_CHARACTERS = 20_000;

export function textRowSpacingTag(text: string): string {
  const spaces: TextRowSpacing['spaces'] = [];
  let length = 0;
  for (const character of Array.from(text)) {
    if (/\s/u.test(character)) {
      const previous = spaces.at(-1);
      if (previous?.offset === length) previous.text += character;
      else spaces.push({ offset: length, text: character });
    } else length++;
  }
  return `${PREFIX}${length}_${spaces.length ? spaces.map(space => `${space.offset}-${/^ +$/.test(space.text) ? `s${space.text.length}` : `u${Array.from(space.text, character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('')}`}`).join('_') : 'N'}`;
}

export function textRowSpacing(tag: unknown): TextRowSpacing | undefined {
  if (typeof tag !== 'string' || tag.length > MAX_CHARACTERS * 12 || !tag.startsWith(PREFIX)) return undefined;
  const [count, ...tokens] = tag.slice(PREFIX.length).split('_');
  if (!/^\d{1,5}$/.test(count) || Number(count) > MAX_CHARACTERS || !tokens.length) return undefined;
  const length = Number(count), spaces: TextRowSpacing['spaces'] = [];
  if (tokens.length === 1 && tokens[0] === 'N') return { length, spaces };
  let whitespace = 0;
  for (const token of tokens) {
    const match = /^(\d{1,5})-(?:s([1-9]\d{0,4})|u((?:[0-9a-f]{4})+))$/.exec(token);
    if (!match) return undefined;
    const offset = Number(match[1]);
    if (offset > length || (spaces.length && offset <= spaces.at(-1)!.offset)) return undefined;
    const size = match[2] ? Number(match[2]) : match[3].length / 4;
    whitespace += size;
    if (whitespace + length > MAX_CHARACTERS) return undefined;
    const text = match[2] ? ' '.repeat(size) : match[3].match(/.{4}/g)!.map(code => String.fromCharCode(parseInt(code, 16))).join('');
    if (!/^[^\S\r\n]+$/u.test(text)) return undefined;
    spaces.push({ offset, text });
  }
  return { length, spaces };
}

export function restoreTextRowSpacing(text: string, metadata?: TextRowSpacing): string | undefined {
  if (!metadata) return undefined;
  const characters = Array.from(text.replace(/\s/gu, ''));
  // Redaction or external editing can invalidate the metadata. Never apply a
  // stale set of positions to the remaining text after a partial removal.
  if (characters.length !== metadata.length) return undefined;
  const spaces = new Map(metadata.spaces.map(space => [space.offset, space.text]));
  return characters.map((character, offset) => (spaces.get(offset) ?? '') + character).join('') + (spaces.get(characters.length) ?? '');
}
