import { describe, expect, it } from 'vitest';

import { isValidFillColor } from '../domain/model';

import {
  DEFAULT_COLOR,
  FILL_COLOR_CHOICES,
  MAX_RECENT_FILL_COLORS,
  pushRecentFillColor,
} from './FieldColorInput';

describe('FieldColorInput palette', () => {
  it('uses the compact fill-color palette, including Excel good/neutral/bad colors', () => {
    const colors = FILL_COLOR_CHOICES.map((choice) => choice.color);

    expect(FILL_COLOR_CHOICES).toHaveLength(7);
    expect(colors).toContain('#C6EFCE');
    expect(colors).toContain('#FFEB9C');
    expect(colors).toContain('#FFC7CE');
    expect(colors.every((color) => isValidFillColor(color))).toBe(true);
    expect(isValidFillColor(DEFAULT_COLOR)).toBe(true);
  });

  it('keeps recent colors unique and most-recent-first', () => {
    const recentColors = Array.from({ length: MAX_RECENT_FILL_COLORS }, (_, index) => `#00000${index}`);
    const updatedWithExisting = pushRecentFillColor(recentColors, '#000003');
    const updatedWithNew = pushRecentFillColor(updatedWithExisting, '#abcdef');

    expect(updatedWithExisting[0]).toBe('#000003');
    expect(updatedWithExisting.filter((color) => color === '#000003')).toHaveLength(1);
    expect(updatedWithNew[0]).toBe('#abcdef');
    expect(updatedWithNew).toHaveLength(MAX_RECENT_FILL_COLORS);
  });
});
