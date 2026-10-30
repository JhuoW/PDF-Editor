/** PDF line breaks describe positioned rows; Enter in an edited draft describes a paragraph break. */
export function originalParagraphText(text: string): string {
  return text.replace(/(?<=[^\n])\n(?=[^\n])/gu, (_match, offset: number, source: string) => {
    const before = source.slice(0, offset), after = source.slice(offset + 1);
    const joined = /[-\u00ad\s]$/u.test(before) || /^\s/u.test(after)
      || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(before)
      || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(after);
    return joined ? '' : ' ';
  });
}
