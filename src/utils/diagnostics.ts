export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}
/** Created only for an explicit copy action; no document bytes or filenames are collected. */
export function diagnosticText(error: unknown, operation: string, locale: string): string {
  return [`PDF-Editor: ${__APP_VERSION__}`, `Operation: ${operation}`, `UI language: ${locale}`,
    `Browser: ${typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent}`, '', errorText(error)].join('\n');
}
