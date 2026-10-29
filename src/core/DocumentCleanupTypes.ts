/** Native selective cleanup targets identifiable PDF features, not arbitrary hidden page content. */
export type CleanupCategory = 'metadata' | 'attachments' | 'activeContent' | 'comments' | 'links' | 'forms' | 'privateData';

/** Every enabled category is removed document-wide. forms removes fields, widgets, values and defaults. */
export type CleanupOptions = Record<CleanupCategory, boolean>;

export interface CleanupFinding {
  /** Opaque identifier scoped to this inspection; findings are not individual deletion requests. */
  id: string;
  category: CleanupCategory;
  label: string;
  details?: string;
  affectsAppearance: boolean;
  /** One-based page numbers; an empty array denotes a document-level feature. */
  pages: number[];
}

export interface CleanupReport {
  revision: string;
  pageCount: number;
  findings: CleanupFinding[];
  counts: Record<CleanupCategory, number>;
  canClean: boolean;
  unsupportedReason?: string;
  hasSignatures: boolean;
  hasXfa: boolean;
  limitations: string[];
}

export interface CleanupControl {
  expectedRevision?: string;
  signal?: AbortSignal;
  onProgress?: (value: { phase: 'inspect' | 'clean' | 'verify' | 'save'; completed: number; total: number }) => void;
}

export interface CleanupResult {
  data: Uint8Array;
  /** A fresh scan of the fully rewritten output. */
  report: CleanupReport;
  removed: Record<CleanupCategory, number>;
}
