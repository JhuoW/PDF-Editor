import { create } from 'zustand';

interface UIState {
  sidebarOpen: boolean;
  sidebarPanel: 'thumbnails' | 'outline' | 'annotations';
  searchOpen: boolean;
  searchQuery: string;

  // Actions
  toggleSidebar: () => void;
  setSidebarPanel: (panel: 'thumbnails' | 'outline' | 'annotations') => void;
  toggleSearch: () => void;
  setSearchQuery: (query: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  sidebarPanel: 'thumbnails',
  searchOpen: false,
  searchQuery: '',

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setSidebarPanel: (panel) => set({ sidebarPanel: panel }),

  toggleSearch: () => set((state) => ({ searchOpen: !state.searchOpen })),

  setSearchQuery: (query) => set({ searchQuery: query }),
}));
