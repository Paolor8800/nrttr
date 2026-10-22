export type RouletteColor = 'red' | 'black' | 'green';

export const ROULETTE_SEQUENCE = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
] as const;

export const ROULETTE_RED_NUMBERS = new Set<number>([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export const ROULETTE_NUMBERS = Array.from({ length: 37 }, (_, number) => number);
export const ROULETTE_POCKET_DEGREES = 360 / ROULETTE_SEQUENCE.length;

export function rouletteColorForNumber(number: number): RouletteColor {
  if (number === 0) return 'green';
  return ROULETTE_RED_NUMBERS.has(number) ? 'red' : 'black';
}

export function rouletteTargetAngle(number: number): number {
  const index = Math.max(0, ROULETTE_SEQUENCE.indexOf(number as (typeof ROULETTE_SEQUENCE)[number]));
  return index * ROULETTE_POCKET_DEGREES + ROULETTE_POCKET_DEGREES / 2;
}
