import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t, useLocale } from '../../i18n';
import { LanguageSwitcher } from '../Workspace/LanguageSwitcher';
import { ErrorMessage } from './ErrorMessage';

export function Recovery({ error, retry }: { error: Error; retry: () => void }) {
  useLocale();
  return <main className="editor-recovery"><LanguageSwitcher /><h1>{t('diagnostics.recoveryTitle')}</h1>
    <p>{t('diagnostics.recoveryHelp')}</p><div role="alert"><ErrorMessage error={error} operation="Render editor" /></div>
    <button type="button" onClick={retry}>{t('diagnostics.retryEditor')}</button>
    <a href="https://github.com/JhuoW/PDF-Editor/issues" target="_blank" rel="noopener noreferrer">{t('feedback.link')}</a>
  </main>;
}
export class EditorErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Editor rendering failed', error, info.componentStack); }
  render() {
    // Retry the mounted UI without clearing document, history or recovery storage.
    return this.state.error ? <Recovery error={this.state.error} retry={() => this.setState({ error: null })} /> : this.props.children;
  }
}
