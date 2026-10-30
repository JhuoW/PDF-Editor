import { create } from 'zustand';

interface UIState {
  workspace: 'home' | 'edit' | 'annotate' | 'organize' | 'convert' | 'forms' | 'protect';
  inspectorOpen: boolean;
  inspectorSection: 'text' | 'box' | 'image';
  setWorkspace: (workspace: UIState['workspace']) => void;
  setInspectorOpen: (open: boolean) => void;
  setInspectorSection: (section: UIState['inspectorSection']) => void;
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
  workspace: 'home',
  inspectorOpen: typeof window !== 'undefined' && window.innerWidth >= 1440,
  inspectorSection: 'text',
  setWorkspace: workspace => set({ workspace }),
  setInspectorOpen: inspectorOpen => set({ inspectorOpen }),
  setInspectorSection: inspectorSection => set({ inspectorSection }),
  sidebarOpen: true,
  sidebarPanel: 'thumbnails',
  searchOpen: false,
  searchQuery: '',

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setSidebarPanel: (panel) => set({ sidebarPanel: panel }),

  toggleSearch: () => set((state) => ({ searchOpen: !state.searchOpen })),

  setSearchQuery: (query) => set({ searchQuery: query }),
}));
