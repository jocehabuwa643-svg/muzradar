import type { Motion } from '@muzradar/shared';
import type { FixState } from './logic';

// Последняя ячейка живёт только в памяти: ни на диск, ни в логи. Общая для экранного наблюдения
// и Live-задачи, чтобы гистерезис не начинался заново при переходе между ними.
let state: FixState = { cell: null, motion: 'still', approx: false };

export function getFixState(): FixState {
  return state;
}

export function setFixState(next: FixState): void {
  state = next;
}

export function resetFixState(motion: Motion = 'still'): void {
  state = { cell: null, motion, approx: false };
}
