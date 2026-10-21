import type { Me, Taste } from '@muzradar/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStateStorage } from '@/lib/storage';

export type OnboardingStep = 'location' | 'consent' | 'name' | 'avatar' | 'taste' | 'done';

export const ONBOARDING_STEPS: readonly Exclude<OnboardingStep, 'done'>[] = ['location', 'consent', 'name', 'avatar', 'taste'];

export interface OnboardingDraft {
  birthYear: number | null;
  name: string | null;
  /** Локальный файл готового аватара (128×128 WebP) — для предпросмотра. */
  avatarUri: string | null;
  taste: Partial<Taste>;
}

interface SessionState {
  userId: string | null;
  /** Последний известный профиль с сервера — чтобы стартовать без сети. */
  me: Me | null;
  /** Последний известный результат гейта геолокации (перепроверяется при каждом возврате в приложение). */
  locationGranted: boolean;
  locationApprox: boolean;
  consentsSaved: boolean;
  avatarSaved: boolean;
  onboardedAt: string | null;
  draft: OnboardingDraft;

  setLocation(granted: boolean, approx: boolean): void;
  updateDraft(patch: Partial<OnboardingDraft>): void;
  markConsentsSaved(): void;
  markAvatarSaved(avatarUri: string | null): void;
  /** Применяет профиль с сервера: восстанавливает пройденные шаги (например, после переустановки). */
  applyServerMe(me: Me, meta?: { isNew?: boolean }): void;
  reset(): void;
}

const emptyDraft: OnboardingDraft = { birthYear: null, name: null, avatarUri: null, taste: {} };

const initial = {
  userId: null,
  me: null,
  locationGranted: false,
  locationApprox: false,
  consentsSaved: false,
  avatarSaved: false,
  onboardedAt: null,
  draft: emptyDraft,
};

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      ...initial,

      setLocation: (granted, approx) => {
        const s = get();
        if (s.locationGranted !== granted || s.locationApprox !== approx) set({ locationGranted: granted, locationApprox: approx });
      },

      updateDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),

      markConsentsSaved: () => set({ consentsSaved: true }),

      markAvatarSaved: (avatarUri) => set((s) => ({ avatarSaved: true, draft: { ...s.draft, avatarUri } })),

      applyServerMe: (me, meta) => {
        const s = get();
        // Сервер создал новый аккаунт, а локально онбординг числился пройденным:
        // аккаунт удалён или секрет потерян — начинаем заново (разрешение геолокации оставляем).
        if (meta?.isNew && (s.onboardedAt || s.userId)) {
          set({ ...initial, locationGranted: s.locationGranted, locationApprox: s.locationApprox, userId: me.id, me });
          return;
        }
        set({
          userId: me.id,
          me,
          consentsSaved: s.consentsSaved || me.consentsVersion !== null,
          avatarSaved: s.avatarSaved || me.avatarUrl !== null,
          onboardedAt: me.onboardedAt,
          draft: {
            ...s.draft,
            birthYear: s.draft.birthYear ?? me.birthYear,
            name: s.draft.name ?? me.name,
            taste: me.taste ?? s.draft.taste,
          },
        });
      },

      reset: () => set({ ...initial }),
    }),
    {
      name: 'session-v1',
      version: 1,
      storage: createJSONStorage(() => mmkvStateStorage),
    },
  ),
);

export function selectOnboardingStep(s: Pick<SessionState, 'onboardedAt' | 'locationGranted' | 'consentsSaved' | 'draft' | 'avatarSaved'>): OnboardingStep {
  if (s.onboardedAt) return 'done';
  if (!s.locationGranted) return 'location';
  if (!s.consentsSaved) return 'consent';
  if (!s.draft.name) return 'name';
  if (!s.avatarSaved) return 'avatar';
  return 'taste';
}

export const useOnboardingStep = () => useSession(selectOnboardingStep);
