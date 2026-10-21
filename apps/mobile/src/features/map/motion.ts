import type { Motion } from '@muzradar/shared';
import type { IconName } from '@/ui/components';

/** Индикатор движения слушателя: подпись и иконка для карточки. */
export const MOTION_META: Record<Motion, { label: string; icon: IconName }> = {
  still: { label: 'стоит', icon: 'body-outline' },
  walk: { label: 'идёт', icon: 'walk-outline' },
  drive: { label: 'едет', icon: 'car-outline' },
};
