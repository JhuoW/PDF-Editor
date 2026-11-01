/** PDF line breaks describe positioned rows; Enter in an edited draft describes a paragraph break. */
export function originalParagraphText(text: string, rows?: ReadonlyArray<{ text: string; joinAfter?: string }>): string {
  // Only use provenance for the physical rows it describes. A draft may already
  // contain deliberate newlines unrelated to the detected source row boundaries.
  const authored = rows && rows.map(row => row.text).join('\n') === text ? rows : undefined;
  let row = 0;
  return text.replace(/(?<=[^\n])\n(?=[^\n])/gu, (_match, offset: number, source: string) => {
    const join = authored?.[row++]?.joinAfter;
    if (join !== undefined) return join;
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
