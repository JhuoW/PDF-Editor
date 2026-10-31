import { create } from 'zustand';
import type { WorkspaceSnapshot } from './workspaceSnapshot';
import { readWorkspace } from './workspaceSnapshot';

export interface PersistedDocumentSaveState { nativeHash?: string; workspaceHash?: string; unsaved?: boolean }
export interface DocumentSavePoint { documentKey: object; nativeHash: string; workspaceHash: string }
interface CurrentDocument { key: object; native: Promise<string>; nativeHash: string | null; workspaceHash: string }
let current: CurrentDocument | null = null;
let saved: PersistedDocumentSaveState | null = null;
let forcedUnsaved = false;
let baselineVersion = 0;

export const useDocumentSaveStore = create<{ isDirty: boolean; ready: boolean; revision: number }>(() => ({ isDirty: false, ready: true, revision: 0 }));
const bufferHashes = new WeakMap<ArrayBuffer, string>();
function fastHash(value: string | Uint8Array): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const item = typeof value === 'string' ? value.charCodeAt(index) : value[index];
    a = Math.imul(a ^ item, 0x01000193); b = Math.imul(b ^ item, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}:${value.length}`;
}
function canonical(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    let hash = bufferHashes.get(value); if (!hash) { hash = fastHash(new Uint8Array(value)); bufferHashes.set(value, hash); }
    return { bytes: hash };
  }
  if (ArrayBuffer.isView(value)) return { bytes: fastHash(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return [...value].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, item]) => [key, canonical(item)]);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== undefined && !['timestamp', 'createdAt', 'modifiedAt'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Editable document content, excluding view state, history and lazy detection caches. */
export function workspaceSaveHash(workspace: WorkspaceSnapshot): string {
  const blocks = new Map([...workspace.editing.textBlocks.values()].flat().map(block => [block.id, block]));
  const images = new Map([...workspace.editing.images.values()].flat().map(image => [image.id, image]));
  return fastHash(JSON.stringify(canonical({
    annotations: new Map([...workspace.annotations].filter(([, annotations]) => annotations.length > 0)),
    values: new Map(workspace.form.fields.map(field => [field.name, field.value])),
    // Font programs are immutable and content-addressed; never hash megabytes on each keystroke.
    text: workspace.editing.textEdits.map(edit => ({ ...edit, font: edit.font?.id, block: blocks.get(edit.blockId) })),
    images: workspace.editing.imageEdits.map(edit => ({ ...edit, image: images.get(edit.imageId) })),
    redactions: workspace.editing.redactions.filter(area => !area.applied),
  })));
}
async function nativeHash(data: ArrayBuffer): Promise<string> {
  if (!crypto.subtle) return `local:${fastHash(new Uint8Array(data))}`;
  const digest = await crypto.subtle.digest('SHA-256', data.slice(0));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function updateDirty() {
  const state = useDocumentSaveStore.getState();
  const isDirty = Boolean(current && (forcedUnsaved || !saved || !current.nativeHash
    || saved.nativeHash !== current.nativeHash || saved.workspaceHash !== current.workspaceHash));
  if (state.isDirty !== isDirty) useDocumentSaveStore.setState({ isDirty });
}

/** Called only when a parsed document has been published, never on navigation. */
export function initializeDocumentSaveState(data: ArrayBuffer, workspace: WorkspaceSnapshot, options: { preserve?: boolean; restored?: PersistedDocumentSaveState } = {}) {
  const workspaceHash = workspaceSaveHash(workspace);
  const previous = current;
  const fresh = !options.preserve || !previous;
  const entry: CurrentDocument = { key: fresh ? {} : previous.key, native: nativeHash(data), nativeHash: null, workspaceHash };
  current = entry;
  const version = fresh ? ++baselineVersion : baselineVersion;
  if (fresh) {
    saved = options.restored?.nativeHash && options.restored.workspaceHash ? { ...options.restored } : null;
    forcedUnsaved = options.restored?.unsaved === true;
    useDocumentSaveStore.setState({ isDirty: forcedUnsaved || Boolean(saved), ready: true });
  } else updateDirty();
  void entry.native.then(hash => {
    if (fresh && !saved && version === baselineVersion && !forcedUnsaved) {
      saved = { nativeHash: hash, workspaceHash };
      useDocumentSaveStore.setState(state => ({ revision: state.revision + 1 }));
    }
    if (current !== entry) { updateDirty(); return; }
    entry.nativeHash = hash; updateDirty();
  }).catch(() => { if (current === entry) useDocumentSaveStore.setState({ isDirty: true, ready: true }); });
}

/** Captures workspace synchronously; later typing cannot be mistaken for saved content. */
export async function captureDocumentSavePoint(): Promise<DocumentSavePoint | null> {
  const entry = current;
  if (!entry) return null;
  const workspaceHash = workspaceSaveHash(readWorkspace());
  return { documentKey: entry.key, nativeHash: await entry.native, workspaceHash };
}
export function refreshDocumentSaveState() {
  if (!current) return;
  current.workspaceHash = workspaceSaveHash(readWorkspace()); updateDirty();
}
export function markDocumentSaved(point: DocumentSavePoint) {
  if (!current || current.key !== point.documentKey) return;
  baselineVersion++; forcedUnsaved = false;
  saved = { nativeHash: point.nativeHash, workspaceHash: point.workspaceHash };
  useDocumentSaveStore.setState(state => ({ revision: state.revision + 1 }));
  refreshDocumentSaveState();
}
export function markDocumentUnsaved() {
  if (!current) return;
  baselineVersion++; forcedUnsaved = true;
  useDocumentSaveStore.setState(state => ({ isDirty: true, revision: state.revision + 1 }));
}
export function captureDocumentFileSaveState(): PersistedDocumentSaveState | undefined {
  return current ? { ...saved, unsaved: forcedUnsaved || !saved } : undefined;
}
export function clearDocumentSaveState() {
  current = null; saved = null; forcedUnsaved = false; baselineVersion++;
  useDocumentSaveStore.setState(state => ({ isDirty: false, ready: true, revision: state.revision + 1 }));
}
