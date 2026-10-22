import { describe, expect, it } from 'vitest';
import {
  ROULETTE_NUMBERS,
  ROULETTE_RED_NUMBERS,
  ROULETTE_SEQUENCE,
  rouletteColorForNumber,
  rouletteTargetAngle,
} from '@/lib/casinoRoulette';

describe('casino roulette table', () => {
  it('keeps the European wheel sequence and color table aligned', () => {
    expect(ROULETTE_SEQUENCE).toHaveLength(37);
    expect(new Set(ROULETTE_SEQUENCE).size).toBe(37);
    const wheelNumbers = new Set<number>(ROULETTE_SEQUENCE);
    expect(ROULETTE_NUMBERS.every((number) => wheelNumbers.has(number))).toBe(true);

    expect(rouletteColorForNumber(0)).toBe('green');
    expect(rouletteColorForNumber(32)).toBe('red');
    expect(rouletteColorForNumber(15)).toBe('black');
    expect(rouletteColorForNumber(19)).toBe('red');
    expect(rouletteColorForNumber(4)).toBe('black');
    expect(ROULETTE_RED_NUMBERS.size).toBe(18);
  });

  it('points every result number to the middle of its visual pocket', () => {
    expect(rouletteTargetAngle(0)).toBeCloseTo(360 / 37 / 2);
    expect(rouletteTargetAngle(32)).toBeCloseTo(360 / 37 + 360 / 37 / 2);
    expect(rouletteTargetAngle(26)).toBeCloseTo(360 - 360 / 37 / 2);
  });
});
