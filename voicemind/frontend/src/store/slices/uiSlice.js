import { createSlice } from '@reduxjs/toolkit';

/**
 * uiSlice — theme handling
 *
 * Three modes:
 *   'dark'   → add class "dark", remove "light"  → CSS vars use dark palette
 *   'light'  → add class "light", remove "dark"  → CSS vars use light palette
 *   'system' → remove both classes               → CSS @media prefers-color-scheme handles it
 *
 * applyTheme is called both inside the reducer (immediate effect) and on
 * initial load. It is safe to call from reducers because it only touches
 * document.documentElement.classList which is outside Redux state.
 */

export const applyTheme = (value) => {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;

  if (value === 'dark') {
    root.classList.add('dark');
    root.classList.remove('light');
  } else if (value === 'light') {
    root.classList.add('light');
    root.classList.remove('dark');
  } else {
    // 'system' — let the CSS @media query decide
    root.classList.remove('dark');
    root.classList.remove('light');
  }
};

const savedTheme = typeof window !== 'undefined'
  ? (localStorage.getItem('voicemind_theme') || 'system')
  : 'system';

const getInitialSidebarState = () => {
  if (typeof window === 'undefined') return true;
  return window.innerWidth >= 1024;
};

const initialState = {
  theme: savedTheme,
  sidebarOpen: getInitialSidebarState(),
  toasts: [],
  modals: { confirm: null, form: null },
  loading: { global: false, actions: {} },
};

// Apply on first load
applyTheme(initialState.theme);

// Re-apply when OS theme changes (only matters while in 'system' mode)
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const stored = localStorage.getItem('voicemind_theme') || 'system';
    if (stored === 'system') {
      applyTheme('system');
    }
  });
}

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setTheme: (state, action) => {
      const value = action.payload || 'system';
      state.theme = value;
      localStorage.setItem('voicemind_theme', value);
      applyTheme(value);
    },
    toggleTheme: (state) => {
      const next = state.theme === 'light' ? 'dark' : 'light';
      state.theme = next;
      localStorage.setItem('voicemind_theme', next);
      applyTheme(next);
    },
    toggleSidebar: (state) => { state.sidebarOpen = !state.sidebarOpen; },
    setSidebarOpen: (state, action) => { state.sidebarOpen = action.payload; },
    addToast: (state, action) => {
      state.toasts.push({ id: Date.now(), ...action.payload });
    },
    removeToast: (state, action) => {
      state.toasts = state.toasts.filter((t) => t.id !== action.payload);
    },
    showConfirmModal: (state, action) => { state.modals.confirm = action.payload; },
    hideConfirmModal: (state) => { state.modals.confirm = null; },
    showFormModal: (state, action) => { state.modals.form = action.payload; },
    hideFormModal: (state) => { state.modals.form = null; },
    setGlobalLoading: (state, action) => { state.loading.global = action.payload; },
    setActionLoading: (state, action) => {
      const { key, value } = action.payload;
      state.loading.actions[key] = value;
    },
  },
});

export const {
  toggleTheme,
  setTheme,
  toggleSidebar,
  setSidebarOpen,
  addToast,
  removeToast,
  showConfirmModal,
  hideConfirmModal,
  showFormModal,
  hideFormModal,
  setGlobalLoading,
  setActionLoading,
} = uiSlice.actions;

export default uiSlice.reducer;