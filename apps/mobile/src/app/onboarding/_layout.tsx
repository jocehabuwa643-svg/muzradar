import { Stack } from 'expo-router';
import { useOnboardingStep } from '@/state/session';
import { colors } from '@/ui/theme';

/** Доступен ровно один шаг — текущий; диплинк на другой шаг не сработает. */
export default function OnboardingLayout() {
  const step = useOnboardingStep();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        animation: 'slide_from_right',
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Protected guard={step === 'location'}>
        <Stack.Screen name="index" />
      </Stack.Protected>
      <Stack.Protected guard={step === 'consent'}>
        <Stack.Screen name="consent" />
      </Stack.Protected>
      <Stack.Protected guard={step === 'name'}>
        <Stack.Screen name="name" />
      </Stack.Protected>
      <Stack.Protected guard={step === 'avatar'}>
        <Stack.Screen name="avatar" />
      </Stack.Protected>
      <Stack.Protected guard={step === 'taste'}>
        <Stack.Screen name="taste" />
      </Stack.Protected>
    </Stack>
  );
}
