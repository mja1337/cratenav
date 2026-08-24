import { describe, expect, it } from 'vitest';
import { DEFAULT_SLEEVE_COLORS, isHexColor, sleevePalette } from '@/sleeves/palette';

describe('replacement sleeve palette', () => {
  it('starts with the four requested colours', () => {
    expect(DEFAULT_SLEEVE_COLORS.map((color) => color.name)).toEqual([
      'Black',
      'White',
      'Teal',
      'Purple',
    ]);
  });

  it('adds valid custom colours and rejects malformed saved entries', () => {
    const palette = sleevePalette({
      customSleeveColors: [
        { id: 'orange', name: 'Orange', hex: '#dd7711' },
        { id: 'broken', name: 'Broken', hex: 'red' },
      ],
    });
    expect(palette.some((color) => color.name === 'Orange')).toBe(true);
    expect(palette.some((color) => color.name === 'Broken')).toBe(false);
  });

  it('accepts only six-digit hex colours', () => {
    expect(isHexColor('#12abEF')).toBe(true);
    expect(isHexColor('#fff')).toBe(false);
    expect(isHexColor('teal')).toBe(false);
  });
});
