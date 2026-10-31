import { useEffect } from 'react';
import { useFontManagerStore } from '../../store/fontManagerStore';
import { useDocumentStore } from '../../store/documentStore';
import { FontManagerDialog } from './FontManagerDialog';
export function FontManagerHost() {
  const request = useFontManagerStore(state => state.request), document = useDocumentStore(state => state.document);
  useEffect(() => { if (request && request.document !== document) useFontManagerStore.setState({ request: null }); }, [request, document]);
  if (!request || request.document !== document) return null;
  const close = () => useFontManagerStore.setState({ request: null });
  return <FontManagerDialog onClose={close} onChoose={font => { request.choose(font); close(); }} />;
}
