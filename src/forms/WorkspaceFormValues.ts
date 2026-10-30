import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { extractFormFields, updateFormFieldValues } from './FormFieldExtractor';

/** Write current values against the native PDF, including resets after prior edits were baked. */
export async function applyCurrentWorkspaceFormValues(
  data: ArrayBuffer,
  workspace: WorkspaceSnapshot,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const writable = workspace.form.fields.filter(field => !field.readOnly && field.type !== 'button' && field.type !== 'signature');
  if (!writable.length) return new Uint8Array(data.slice(0));
  const nativeFields = await extractFormFields(data.slice(0));
  signal?.throwIfAborted();
  const byName = new Map(nativeFields.map(field => [field.name, field]));
  const values = new Map(writable.flatMap(field => {
    const native = byName.get(field.name);
    return !native || native.readOnly || native.type === 'button' || native.type === 'signature'
      || JSON.stringify(field.value) === JSON.stringify(native.value)
      ? [] : [[field.name, structuredClone(field.value)] as const];
  }));
  if (!values.size) return new Uint8Array(data.slice(0));
  const result = await updateFormFieldValues(data.slice(0), values);
  signal?.throwIfAborted();
  return result;
}
