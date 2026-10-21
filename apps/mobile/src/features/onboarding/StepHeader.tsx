import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { ONBOARDING_STEPS } from '@/state/session';
import { StepDots, Txt } from '@/ui/components';
import { colors, space } from '@/ui/theme';
import { enterUp } from './motion';

export const ONBOARDING_TOTAL = ONBOARDING_STEPS.length;

export interface StepHeaderProps {
  /** Номер шага с нуля. */
  step: number;
  overline: string;
  title: string;
  subtitle?: string;
}

export function StepHeader({ step, overline, title, subtitle }: StepHeaderProps) {
  return (
    <View style={styles.wrap}>
      <Animated.View entering={enterUp(0)}>
        <StepDots total={ONBOARDING_TOTAL} current={step} />
      </Animated.View>
      <Animated.View entering={enterUp(1)} style={styles.text}>
        <Txt variant="overline" color={colors.textFaint}>
          {overline}
        </Txt>
        <Txt variant="title" accessibilityRole="header">
          {title}
        </Txt>
        {subtitle ? <Txt color={colors.textMuted}>{subtitle}</Txt> : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space(6) },
  text: { gap: space(2) },
});
