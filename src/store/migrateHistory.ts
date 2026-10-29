import type { Annotation } from '../annotations/types';
import type { WorkspaceSnapshot } from './workspaceSnapshot';
import type { HistoryTimeline, WorkspaceHistoryEntry } from './historyStore';
import type { HistoryEntry } from './annotationHistoryStore';

/** Fold the former annotation stacks into the same chronological timeline. */
export function migrateLegacyHistory(workspace: WorkspaceSnapshot, timeline: HistoryTimeline, limit = 20) {
  const { past, future } = workspace.annotationHistory;
  if (!past.length && !future.length) return { workspace, history: timeline };
  const apply = (annotations: Map<number, Annotation[]>, entry: HistoryEntry, undo: boolean) => {
    const target = undo ? entry.previousState ?? entry.annotation : entry.annotation;
    const remove = undo ? entry.type === 'add' : entry.type === 'delete';
    const next = new Map(annotations);
    for (const [page, items] of next) next.set(page, items.filter(item => item.id !== entry.annotation.id));
    if (!remove) next.set(target.pageNumber, [...(next.get(target.pageNumber) ?? []), structuredClone(target)]);
    return next;
  };
  let previous = workspace.annotations;
  const undone: WorkspaceHistoryEntry[] = [];
  for (const entry of [...past].reverse()) {
    previous = apply(previous, entry, true);
    undone.push({ kind: 'workspace', actionName: 'Edit annotation', timestamp: Date.now(), patch: { annotations: structuredClone(previous) } });
  }
  let next = workspace.annotations;
  const redone: WorkspaceHistoryEntry[] = [];
  for (const entry of future) {
    next = apply(next, entry, false);
    redone.push({ kind: 'workspace', actionName: 'Edit annotation', timestamp: Date.now(), patch: { annotations: structuredClone(next) } });
  }
  return {
    workspace: { ...workspace, annotationHistory: { past: [], future: [] } },
    history: { undoStack: [...timeline.undoStack, ...undone.reverse()].slice(-limit), redoStack: [...timeline.redoStack, ...redone.reverse()].slice(-limit) },
  };
}
