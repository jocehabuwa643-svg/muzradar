import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions, type PermissionResponse } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Image, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocationGate } from '@/features/location/gate';
import { AVATAR_FAILURE_MESSAGES, buildAvatar, type AvatarFailure, type AvatarImage } from '@/features/onboarding/avatarPipeline';
import { avatarUploadError, useStepNotice, type StepError } from '@/features/onboarding/completion';
import { FACE_VERDICT_MESSAGES } from '@/features/onboarding/faceCheck';
import { warmUpFaceDetector } from '@/features/onboarding/faceDetector';
import { FaceMask, maskCircle } from '@/features/onboarding/FaceMask';
import { enterFade, enterReveal, enterUp } from '@/features/onboarding/motion';
import { ONBOARDING_TOTAL, StepHeader } from '@/features/onboarding/StepHeader';
import { api } from '@/lib/api';
import { useSession } from '@/state/session';
import { Button, Notice, Screen, StepDots, Txt, type IconName } from '@/ui/components';
import { colors, radius, space } from '@/ui/theme';

const STEP = 3;
const OVERLINE = 'Шаг 4 из 5 · Фото';

function failureCopy(reason: AvatarFailure): { title: string; hint: string } {
  return reason === 'too-heavy' || reason === 'failed' ? AVATAR_FAILURE_MESSAGES[reason] : FACE_VERDICT_MESSAGES[reason];
}

/**
 * Шаг 4 — аватар, только с камеры: ни кнопки галереи, ни доступа к медиатеке.
 * Снимок проверяется и ужимается на устройстве; на сервер уходит только готовый 128×128 WebP.
 */
export default function AvatarStep() {
  useLocationGate();
  const [permission, requestPermission, getPermission] = useCameraPermissions();

  // Возврат из Настроек: хук сам разрешение не перечитывает
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void getPermission().catch(() => undefined);
    });
    return () => sub.remove();
  }, [getPermission]);

  if (!permission) return <View style={styles.fill} testID="onboarding-avatar-loading" />;
  if (!permission.granted) return <CameraPermissionView permission={permission} onRequest={requestPermission} />;
  return <AvatarCapture />;
}

// ─── Разрешение камеры ───────────────────────────────────────────────────────

const PROMISES: { icon: IconName; text: string }[] = [
  { icon: 'camera-reverse-outline', text: 'Фронтальная камера, один кадр' },
  { icon: 'images-outline', text: 'Галерея не используется — ни доступа, ни кнопки' },
  { icon: 'eye-off-outline', text: 'Лицо не используется для распознавания' },
];

function CameraPermissionView({ permission, onRequest }: { permission: PermissionResponse; onRequest: () => Promise<PermissionResponse> }) {
  const [busy, setBusy] = useState(false);
  const { notice } = useStepNotice('avatar');
  const canAsk = permission.canAskAgain;
  const web = Platform.OS === 'web';

  const onPress = async () => {
    setBusy(true);
    try {
      if (canAsk || web) await onRequest();
      else await Linking.openSettings();
    } catch (err) {
      console.warn('[avatar] camera permission failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      scroll
      footer={
        <Button
          label={canAsk ? 'Разрешить камеру' : web ? 'Проверить снова' : 'Открыть настройки'}
          icon={canAsk ? 'camera' : 'settings-outline'}
          loading={busy}
          onPress={() => void onPress()}
          accessibilityHint={canAsk || web ? 'Откроет запрос доступа к камере' : 'Откроет настройки приложения'}
          testID="camera-permission-action"
        />
      }
      testID="onboarding-avatar-permission"
    >
      <StepHeader
        step={STEP}
        overline={OVERLINE}
        title="Фото — только с камеры"
        subtitle="Один снимок лица для метки на карте. Без галереи и фильтров: на радаре — живые люди."
      />

      <Animated.View entering={enterUp(2)} style={styles.illustration}>
        <View style={styles.illustrationRing}>
          <Ionicons name="person-outline" size={56} color={colors.textMuted} />
        </View>
      </Animated.View>

      <Animated.View entering={enterUp(3)} style={styles.promises}>
        {PROMISES.map((p) => (
          <View key={p.icon} style={styles.promise}>
            <Ionicons name={p.icon} size={20} color={colors.textMuted} />
            <Txt variant="label" color={colors.textMuted} style={styles.flexText}>
              {p.text}
            </Txt>
          </View>
        ))}
      </Animated.View>

      {notice ? (
        <Animated.View entering={enterFade()} style={styles.noticeGap}>
          <Notice tone="warning" title={notice.title}>
            {notice.text}
          </Notice>
        </Animated.View>
      ) : null}

      {!canAsk ? (
        <Animated.View entering={enterFade()} style={styles.noticeGap}>
          <Notice tone="warning" title="Доступ к камере запрещён">
            {Platform.OS === 'ios'
              ? 'Откройте Настройки → МУЗРАДАР и включите «Камера».'
              : web
                ? 'Разрешите камеру в настройках сайта в браузере, затем нажмите «Проверить снова».'
                : 'Откройте настройки → Разрешения → Камера и выберите «Разрешить только во время использования».'}
          </Notice>
        </Animated.View>
      ) : null}
    </Screen>
  );
}

// ─── Съёмка ──────────────────────────────────────────────────────────────────

type Phase = { kind: 'camera' } | { kind: 'processing' } | { kind: 'preview'; avatar: AvatarImage };

function AvatarCapture() {
  const cameraRef = useRef<CameraView>(null);
  const busy = useRef(false);
  const insets = useSafeAreaInsets();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'camera' });
  const [failure, setFailure] = useState<AvatarFailure | null>(null);
  const [mountError, setMountError] = useState<string | null>(null);
  const [cameraKey, setCameraKey] = useState(0);
  const { notice } = useStepNotice('avatar');

  useEffect(() => {
    // модель ML Kit грузится, пока человек выстраивает кадр
    warmUpFaceDetector();
  }, []);

  const capture = async () => {
    const camera = cameraRef.current;
    if (!camera || !ready || busy.current) return;
    busy.current = true;
    setFailure(null);
    setPhase({ kind: 'processing' });
    let next: Phase = { kind: 'camera' };
    let reason: AvatarFailure | null = null;
    try {
      // exif:false + skipProcessing:false — камера сама поворачивает пиксели, и рамка лица совпадает с картинкой
      const shot = await camera.takePictureAsync({ quality: 0.8, exif: false, skipProcessing: false, shutterSound: false });
      const result = await buildAvatar(shot.uri);
      if (result.ok) next = { kind: 'preview', avatar: result.avatar };
      else {
        reason = result.reason;
        if (result.reason === 'failed') console.warn('[avatar] pipeline failed', result.error);
      }
    } catch (err) {
      console.warn('[avatar] capture failed', err);
      reason = 'failed';
    } finally {
      busy.current = false;
    }
    void Haptics.notificationAsync(reason ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success).catch(
      () => undefined,
    );
    setFailure(reason);
    if (next.kind === 'preview') setReady(false);
    setPhase(next);
  };

  const retake = () => {
    setFailure(null);
    setReady(false);
    setPhase({ kind: 'camera' });
  };

  if (phase.kind === 'preview') return <AvatarPreview avatar={phase.avatar} onRetake={retake} />;

  const processing = phase.kind === 'processing';
  const copy = failure ? failureCopy(failure) : null;

  return (
    <View
      style={styles.fill}
      onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      testID="onboarding-avatar-camera"
    >
      {mountError === null ? (
        <CameraView
          key={cameraKey}
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="front"
          mirror
          mode="picture"
          animateShutter={false}
          onCameraReady={() => setReady(true)}
          onMountError={(e) => setMountError(e.message)}
        />
      ) : null}

      {size ? <FaceMask width={size.width} height={size.height} circle={maskCircle(size.width, size.height)} tone={copy ? 'warning' : 'idle'} /> : null}

      <View style={[styles.chrome, { paddingTop: insets.top + space(4), paddingBottom: insets.bottom + space(6) }]} pointerEvents="box-none">
        <Animated.View entering={enterUp(0)} style={styles.top}>
          <StepDots total={ONBOARDING_TOTAL} current={STEP} />
          <Txt variant="heading" align="center" accessibilityRole="header">
            Лицо в круг, смотрите прямо
          </Txt>
        </Animated.View>

        <View style={styles.bottom} pointerEvents="box-none">
          {mountError !== null ? (
            <View style={styles.status}>
              <Notice tone="danger" title="Камера недоступна">
                Закройте другие приложения, которые используют камеру, и попробуйте снова.
              </Notice>
              <Button
                label="Попробовать снова"
                variant="secondary"
                onPress={() => {
                  setMountError(null);
                  setReady(false);
                  setCameraKey((k) => k + 1);
                }}
              />
            </View>
          ) : (
            <>
              <View style={styles.status} accessibilityLiveRegion="polite">
                {copy ? (
                  <Animated.View key={failure} entering={enterFade()} style={styles.verdict}>
                    <Txt variant="label" color={colors.warning} align="center">
                      {copy.title}
                    </Txt>
                    <Txt variant="caption" color={colors.textMuted} align="center">
                      {copy.hint}
                    </Txt>
                  </Animated.View>
                ) : notice ? (
                  <Notice tone="warning" title={notice.title}>
                    {notice.text}
                  </Notice>
                ) : (
                  <Txt variant="caption" color={colors.textMuted} align="center">
                    Хороший свет спереди, телефон на уровне глаз
                  </Txt>
                )}
              </View>
              <Shutter disabled={!ready || processing} onPress={() => void capture()} />
            </>
          )}
        </View>
      </View>

      {processing ? (
        <Animated.View entering={enterFade(160)} style={styles.processing} accessibilityLiveRegion="assertive">
          <ActivityIndicator color={colors.accent} size="large" />
          <Txt variant="label">Проверяем кадр…</Txt>
        </Animated.View>
      ) : null}
    </View>
  );
}

function Shutter({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Сделать снимок"
      accessibilityHint="Снимок проверится прямо на телефоне"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.shutter, disabled && styles.shutterDisabled, pressed && !disabled && styles.shutterPressed]}
      testID="avatar-shutter"
    >
      <View style={styles.shutterCore} />
    </Pressable>
  );
}

// ─── Предпросмотр и загрузка ─────────────────────────────────────────────────

function AvatarPreview({ avatar, onRetake }: { avatar: AvatarImage; onRetake: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<StepError | null>(null);
  const { dismiss } = useStepNotice('avatar');

  const upload = async () => {
    setUploading(true);
    setError(null);
    try {
      await api.putAvatar(avatar.base64);
      dismiss();
      useSession.getState().markAvatarSaved(avatar.uri);
    } catch (err) {
      // null: сервер вернул на шаг согласий, экран сейчас сменится
      setError(avatarUploadError(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Screen
      footer={
        <>
          {error ? <Notice tone={error.kind === 'network' ? 'warning' : 'danger'} title={error.message} /> : null}
          <View style={styles.actions}>
            <Button label="Переснять" variant="secondary" icon="refresh" onPress={onRetake} disabled={uploading} block={false} style={styles.action} testID="avatar-retake" />
            <Button
              label={error?.kind === 'network' ? 'Повторить' : 'Готово'}
              onPress={() => void upload()}
              loading={uploading}
              disabled={error?.kind === 'rejected'}
              block={false}
              style={styles.action}
              testID="avatar-done"
            />
          </View>
        </>
      }
      testID="onboarding-avatar-preview"
    >
      <StepHeader step={STEP} overline={OVERLINE} title="Так вас увидят" subtitle="Фото появится в метке на карте, рядом с тем, что вы слушаете." />
      <View style={styles.previewArea}>
        <Animated.View entering={enterReveal} style={styles.previewRing}>
          <Image source={{ uri: avatar.uri }} style={styles.previewImage} accessibilityLabel="Ваше фото для аватара" />
        </Animated.View>
      </View>
    </Screen>
  );
}

const PREVIEW = 196;
const SHUTTER = 80;

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  flexText: { flex: 1 },
  illustration: { alignItems: 'center', marginTop: space(10), marginBottom: space(8) },
  illustrationRing: {
    width: 148,
    height: 148,
    borderRadius: 74,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    borderStyle: 'dashed',
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  promises: { gap: space(3) },
  promise: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  noticeGap: { marginTop: space(5) },
  chrome: { ...StyleSheet.absoluteFill, justifyContent: 'space-between', paddingHorizontal: space(5) },
  top: { alignItems: 'center', gap: space(4) },
  bottom: { alignItems: 'center', gap: space(5) },
  status: { alignSelf: 'stretch', minHeight: 48, justifyContent: 'center', gap: space(3) },
  verdict: {
    alignSelf: 'center',
    gap: space(1),
    paddingHorizontal: space(5),
    paddingVertical: space(3),
    borderRadius: radius.lg,
    backgroundColor: colors.overlay,
  },
  shutter: {
    width: SHUTTER,
    height: SHUTTER,
    borderRadius: SHUTTER / 2,
    borderWidth: 4,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterCore: { width: SHUTTER - 18, height: SHUTTER - 18, borderRadius: (SHUTTER - 18) / 2, backgroundColor: colors.text },
  shutterDisabled: { opacity: 0.35 },
  shutterPressed: { transform: [{ scale: 0.94 }] },
  processing: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space(4),
  },
  previewArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: space(10) },
  previewRing: {
    width: PREVIEW + 12,
    height: PREVIEW + 12,
    borderRadius: (PREVIEW + 12) / 2,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: { width: PREVIEW, height: PREVIEW, borderRadius: PREVIEW / 2, backgroundColor: colors.surface2 },
  actions: { flexDirection: 'row', gap: space(3) },
  action: { flex: 1 },
});
