import { Easing, FadeIn, FadeInDown, Keyframe } from 'react-native-reanimated';

/** Сильный ease-out для UI: движение заметно сразу, а не в конце. */
export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/**
 * Появление контента шага: короткий подъём на 12 px с затуханием, лесенкой по index.
 * Под «уменьшением движения» Reanimated пропускает layout-анимации сам (ReduceMotion.System).
 */
export const enterUp = (index = 0) =>
  FadeInDown.duration(380)
    .delay(60 + index * 70)
    .easing(EASE_OUT)
    .withInitialValues({ opacity: 0, transform: [{ translateY: 12 }] });

/** Смена состояния без сдвига: баннеры, оверлеи. */
export const enterFade = (duration = 200) => FadeIn.duration(duration).easing(EASE_OUT);

/** Предпросмотр аватара: из 0.94, не из нуля — появление, а не «вылет». */
export const enterReveal = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.94 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: EASE_OUT },
}).duration(280);
