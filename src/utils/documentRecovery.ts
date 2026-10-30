export const CURRENT_TAB_SESSION_KEY = 'pdf-editor.active-document-session';

export function rememberTabDocumentSession(sessionId: string) {
  try { sessionStorage.setItem(CURRENT_TAB_SESSION_KEY, sessionId); } catch { /* Recovery is optional. */ }
}
export function forgetTabDocumentSession(sessionId?: string) {
  try {
    if (!sessionId || sessionStorage.getItem(CURRENT_TAB_SESSION_KEY) === sessionId) sessionStorage.removeItem(CURRENT_TAB_SESSION_KEY);
  } catch { /* Recovery is optional. */ }
}

/** Recovery belongs only to this tab's actual reload, never a new visit. */
export function reloadOwnedDocumentSession(): string | null {
  const navigation = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (navigation?.type !== 'reload') { forgetTabDocumentSession(); return null; }
  try { return sessionStorage.getItem(CURRENT_TAB_SESSION_KEY); } catch { return null; }
}
