import { describe, expect, it } from 'vitest';
import { isCdTrackPosition } from '@/discogs/track-position';

describe('CD track positions', () => {
  it.each(['CD', 'CD1', 'CD-1', 'CD 2', 'cd.03'])('recognises %s', (position) => {
    expect(isCdTrackPosition(position)).toBe(true);
  });

  it.each(['A1', 'B-2', '1-1', 'Side A', 'DVD-1', ''])('does not hide %s', (position) => {
    expect(isCdTrackPosition(position)).toBe(false);
  });
});
