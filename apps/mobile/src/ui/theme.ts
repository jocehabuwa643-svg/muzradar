import type { TextStyle } from 'react-native';

export const colors = {
  bg: '#07070C',
  surface: '#0F0F17',
  surface2: '#171722',
  surface3: '#20202D',
  border: '#262634',
  borderStrong: '#3A3A4C',
  text: '#F3F3F8',
  textMuted: '#A0A0B4',
  textFaint: '#62627A',
  /** Сигнал радара: активные состояния, «в эфире», основная кнопка. */
  accent: '#C8FF3D',
  accentInk: '#0A0A0F',
  accentSoft: 'rgba(200,255,61,0.14)',
  /** Музыкальный слой: треки, плеер, настроения. */
  violet: '#8C7BFF',
  violetSoft: 'rgba(140,123,255,0.16)',
  danger: '#FF5A76',
  dangerSoft: 'rgba(255,90,118,0.14)',
  warning: '#FFB84D',
  overlay: 'rgba(7,7,12,0.78)',
  transparent: 'transparent',
} as const;

/** Имена совпадают с ключами, под которыми шрифты грузятся в корневом layout. */
export const fonts = {
  display: 'Unbounded_700Bold',
  displayMedium: 'Unbounded_500Medium',
  body: 'Manrope_500Medium',
  bodyRegular: 'Manrope_400Regular',
  bodySemi: 'Manrope_600SemiBold',
  bodyBold: 'Manrope_700Bold',
} as const;

export const space = (n: number) => n * 4;

export const radius = { sm: 10, md: 16, lg: 24, xl: 32, pill: 999 } as const;

export const typography = {
  hero: { fontFamily: fonts.display, fontSize: 32, lineHeight: 38, letterSpacing: -0.6 },
  title: { fontFamily: fonts.display, fontSize: 24, lineHeight: 30, letterSpacing: -0.4 },
  heading: { fontFamily: fonts.displayMedium, fontSize: 18, lineHeight: 24, letterSpacing: -0.2 },
  body: { fontFamily: fonts.body, fontSize: 16, lineHeight: 23 },
  bodyStrong: { fontFamily: fonts.bodySemi, fontSize: 16, lineHeight: 23 },
  label: { fontFamily: fonts.bodySemi, fontSize: 14, lineHeight: 18 },
  caption: { fontFamily: fonts.bodyRegular, fontSize: 12, lineHeight: 16 },
  overline: { fontFamily: fonts.bodyBold, fontSize: 11, lineHeight: 14, letterSpacing: 1.4, textTransform: 'uppercase' },
} satisfies Record<string, TextStyle>;

export type TypographyVariant = keyof typeof typography;

/** Минимальная зона нажатия (Apple HIG 44 pt, Material 48 dp). */
export const HIT = 48;
