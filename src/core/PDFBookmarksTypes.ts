import type { PDFLinkControl, PDFLinkInspection, PDFLinkTarget } from './PDFLinkTypes';

export interface PDFBookmarkDefinition {
  title: string;
  /** null is a heading without a navigation action. */
  target: PDFLinkTarget | null;
  bold: boolean;
  italic: boolean;
  color: string;
  expanded: boolean;
}
export interface PDFBookmarkDraft {
  /** Existing IDs are revision-scoped. New nodes use draft-<unique identifier>. */
  id: string;
  definition: PDFBookmarkDefinition;
  children: PDFBookmarkDraft[];
}
export interface PDFBookmarkInfo extends Omit<PDFBookmarkDraft, 'children'> {
  children: PDFBookmarkInfo[];
  editable: boolean;
  removable: boolean;
  movable: boolean;
  unsupportedReason?: string;
  namedDestination?: string;
}
export interface PDFBookmarkInspection {
  revision: string;
  pages: PDFLinkInspection['pages'];
  bookmarks: PDFBookmarkInfo[];
  canEdit: boolean;
  unsupportedReason?: string;
}
export type PDFBookmarkControl = PDFLinkControl;
export const PDF_BOOKMARK_LIMITS = {
  inputBytes: 200 * 1024 * 1024, pages: 2000, bookmarks: 10000,
  depth: 64, titleCharacters: 4096,
};
