import type { StateStorage } from 'zustand/middleware';

export const mmkv = {
  getString: (name: string) => localStorage.getItem(name) ?? undefined,
  set: (name: string, value: string) => localStorage.setItem(name, value),
  remove: (name: string) => localStorage.removeItem(name),
};

export const mmkvStateStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  setItem: (name, value) => localStorage.setItem(name, value),
  removeItem: (name) => localStorage.removeItem(name),
};
