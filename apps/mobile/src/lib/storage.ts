import { createMMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

/** Синхронное хранилище: сторы готовы уже на первом рендере — онбординг не «мелькает». */
export const mmkv = createMMKV({ id: 'muzradar' });

export const mmkvStateStorage: StateStorage = {
  getItem: (name) => mmkv.getString(name) ?? null,
  setItem: (name, value) => mmkv.set(name, value),
  removeItem: (name) => {
    mmkv.remove(name);
  },
};
