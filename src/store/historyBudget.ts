import type { HistorySnapshot, HistoryTimeline } from './historyStore';

export const HISTORY_BYTE_BUDGET = 128 * 1024 * 1024;
const sizes = new WeakMap<HistorySnapshot, number>();

/** Conservative retained-size estimate, including images, strings and PDF buffers. */
export function historyEntryBytes(entry: HistorySnapshot): number {
  const cached = sizes.get(entry);
  if (cached !== undefined) return cached;
  const seen = new Set<object>();
  function size(value: unknown): number {
    if (typeof value === 'string') return value.length * 2;
    if (!value || typeof value !== 'object') return 8;
    if (seen.has(value)) return 0;
    seen.add(value);
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return size(value.buffer);
    if (value instanceof Map) return 48 + [...value].reduce((sum, [key, item]) => sum + size(key) + size(item), 0);
    if (value instanceof Set) return 48 + [...value].reduce((sum, item) => sum + size(item), 0);
    return 32 + Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + size(item), 0);
  }
  const bytes = size(entry); sizes.set(entry, bytes); return bytes;
}

type BudgetState = HistoryTimeline & { groupUndo?: HistorySnapshot[] | null; groupRedo?: HistorySnapshot[] | null };
/** Trim only prefixes: skipping a middle checkpoint breaks the undo timeline.
 * Keep the nearest inverse action even when that single action exceeds the budget.
 * The immutable original and the live document are not part of the undo budget.
 */
export function boundHistory<T extends BudgetState>(state: T, maxHistory: number, maxBytes = HISTORY_BYTE_BUDGET, preferred: 'undo' | 'redo' = 'undo') {
  const keys = ['undoStack', 'redoStack', 'groupUndo', 'groupRedo'] as const;
  const result = { ...state };
  for (const key of keys) if (state[key]) result[key] = state[key]!.slice(-maxHistory);
  const protectedEntry = (preferred === 'undo' ? result.undoStack : result.redoStack).at(-1);
  const entries = () => new Set(keys.flatMap(key => result[key] ?? []));
  let bytes = [...entries()].reduce((sum, entry) => sum + historyEntryBytes(entry), 0);
  let trimmed = false;
  while (bytes > maxBytes) {
    const candidates = keys.map(key => result[key]?.[0]).filter((entry): entry is HistorySnapshot => !!entry && entry !== protectedEntry);
    const oldest = candidates.sort((a, b) => a.timestamp - b.timestamp)[0];
    if (!oldest) break;
    for (const key of keys) {
      const index = result[key]?.indexOf(oldest) ?? -1;
      if (index >= 0) result[key] = result[key]!.slice(index + 1);
    }
    trimmed = true;
    bytes = [...entries()].reduce((sum, entry) => sum + historyEntryBytes(entry), 0);
  }
  return { state: result, bytes, trimmed };
}
