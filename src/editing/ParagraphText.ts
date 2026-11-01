/** PDF line breaks describe positioned rows; Enter in an edited draft describes a paragraph break. */
export function originalParagraphText(text: string): string {
  return text.replace(/(?<=[^\n])\n(?=[^\n])/gu, (_match, offset: number, source: string) => {
    const before = source.slice(0, offset), after = source.slice(offset + 1);
    const joined = /[-\u00ad\u2010\s]$/u.test(before) || /^\s/u.test(after)
      || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(before)
      || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(after);
    return joined ? '' : ' ';
  });
}

/** Only an explicit discretionary hyphen may disappear during reflow. A line-end
 * '-' can also belong to a compound (state-of-the-art); guessing silently changes
 * the text the user just confirmed, especially after saving and reopening it. */
export function isSoftHyphenBreak(row: string): boolean { return row.endsWith('\u00ad'); }
