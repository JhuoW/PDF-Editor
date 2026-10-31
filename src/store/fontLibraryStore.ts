import { create } from 'zustand';
import type { FontAsset } from '../fonts/fontAsset';
import { fontLibrary } from '../fonts/fontLibrary';
import { useEditingStore } from './editingStore';
export const useFontLibraryStore = create<{ fonts: FontAsset[] }>(() => ({ fonts: [] }));
/** Reuse immutable programs across blocks instead of retaining a fresh byte copy per selection. */
export function publishFontLibrary(fonts: FontAsset[]) {
  const known = new Map(useFontLibraryStore.getState().fonts.map(font => [font.id, font]));
  for (const edit of useEditingStore.getState().textEdits) if (edit.font) known.set(edit.font.id, edit.font);
  useFontLibraryStore.setState({ fonts: fonts.map(font => known.get(font.id) ?? font) });
}
export async function refreshFontLibrary() { publishFontLibrary(await fontLibrary()); }
