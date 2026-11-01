import { prepareTextEditLayout, type TextLayoutContext } from './TextEditApplier';
import { previewWorkspaceTextEdit } from '../core/TextLayoutPreviewWorkspace';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import type { TextBlock, TextEditOperation } from './types';

type Request = { data: ArrayBuffer } & ({ job: 'prepare'; block: TextBlock; edit?: TextEditOperation; context?: TextLayoutContext }
  | { job: 'preview'; workspace: WorkspaceSnapshot; edit: TextEditOperation });

self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const request = event.data;
    if (!(request?.data instanceof ArrayBuffer)) throw new Error('The text layout worker received invalid PDF data.');
    if (request.job === 'prepare') {
      const result = await prepareTextEditLayout(request.data, request.block, request.edit, {}, request.context);
      self.postMessage({ type: 'result', result });
    } else if (request.job === 'preview') {
      const result = await previewWorkspaceTextEdit(request.data, request.workspace, request.edit);
      self.postMessage({ type: 'result', result }, { transfer: [result.buffer] });
    } else throw new Error('Unknown text layout operation.');
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not prepare the text layout.' });
  }
};
