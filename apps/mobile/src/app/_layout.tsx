// Фоновые модули должны быть загружены в глобальной области до любого рендера.
import '@/features/location/liveTask';
import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular';
import { Manrope_500Medium } from '@expo-google-fonts/manrope/500Medium';
import { Manrope_600SemiBold } from '@expo-google-fonts/manrope/600SemiBold';
import { Manrope_700Bold } from '@expo-google-fonts/manrope/700Bold';
import { Unbounded_500Medium } from '@expo-google-fonts/unbounded/500Medium';
import { Unbounded_700Bold } from '@expo-google-fonts/unbounded/700Bold';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { SplashScreen, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LocationGate } from '@/features/location/LocationGate';
import { initPlayer } from '@/features/player';
import { appConfig } from '@/lib/config';
import { useBootstrap } from '@/lib/bootstrap';
import { useOnboardingStep, useSession } from '@/state/session';
import { colors } from '@/ui/theme';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);
void initPlayer().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 2, refetchOnWindowFocus: false },
  },
});

export default function RootLayout() {
  const locationGranted = useSession((s) => s.locationGranted);
  const [fontsLoaded, fontError] = useFonts({
    Unbounded_500Medium,
    Unbounded_700Bold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
  });
  // MMKV синхронный: к первому рендеру состояние уже восстановлено
  const hydrated = useSession.persist.hasHydrated();
  const step = useOnboardingStep();
  const done = step === 'done';
  const ready = hydrated && (fontsLoaded || fontError !== null);
  const blocking = done && appConfig.locationGate === 'hard' && !locationGranted;

  useBootstrap(done);

  useEffect(() => {
    if (ready) SplashScreen.hide();
  }, [ready]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          {/* Пока сверху висит экран блокировки, скринридер не должен добираться до приложения:
              accessibilityViewIsModal на LocationGate работает только в iOS. */}
          <View
            style={styles.root}
            importantForAccessibility={blocking ? 'no-hide-descendants' : 'auto'}
            accessibilityElementsHidden={blocking}
          >
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.bg },
              animation: 'fade',
            }}
          >
            <Stack.Protected guard={done}>
              <Stack.Screen name="(app)" />
              <Stack.Screen name="player" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
            </Stack.Protected>
            <Stack.Protected guard={!done}>
              <Stack.Screen name="onboarding" />
            </Stack.Protected>
          </Stack>
          </View>
          {done ? <LocationGate /> : null}
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
