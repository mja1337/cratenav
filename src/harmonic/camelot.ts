import type { CamelotKey, MusicalKey, PitchClass, Tonality } from '@/domain/types';

/**
 * Camelot wheel <-> musical key conversion. Spec §12.
 *
 * The wheel is the circle of fifths: moving up one number is a perfect fifth
 * up, and the A/B pair at a given number are relative minor/major. The table
 * is written out explicitly rather than computed, because an off-by-one in
 * generated modular arithmetic is silent and this is load-bearing for every
 * mix suggestion the app makes.
 */

interface WheelEntry {
  number: number;
  /** Relative minor — Camelot "A". */
  minor: PitchClass;
  /** Major — Camelot "B". */
  major: PitchClass;
}

const WHEEL: WheelEntry[] = [
  { number: 1, minor: 'G#', major: 'B' },
  { number: 2, minor: 'D#', major: 'F#' },
  { number: 3, minor: 'A#', major: 'C#' },
  { number: 4, minor: 'F', major: 'G#' },
  { number: 5, minor: 'C', major: 'D#' },
  { number: 6, minor: 'G', major: 'A#' },
  { number: 7, minor: 'D', major: 'F' },
  { number: 8, minor: 'A', major: 'C' },
  { number: 9, minor: 'E', major: 'G' },
  { number: 10, minor: 'B', major: 'D' },
  { number: 11, minor: 'F#', major: 'A' },
  { number: 12, minor: 'C#', major: 'E' },
];

/** Flat spellings mapped to the canonical sharp spelling. Spec §12 enharmonics. */
const ENHARMONIC: Record<string, PitchClass> = {
  DB: 'C#', EB: 'D#', GB: 'F#', AB: 'G#', BB: 'A#',
  // Theoretical / lazy spellings that turn up in provider metadata.
  'E#': 'F', 'B#': 'C', CB: 'B', FB: 'E',
};

const SHARP_TO_FLAT: Partial<Record<PitchClass, string>> = {
  'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb',
};

export function camelotToMusicalKey(camelot: CamelotKey): MusicalKey | null {
  const entry = WHEEL.find((w) => w.number === camelot.number);
  if (!entry) return null;
  return {
    pitchClass: camelot.letter === 'A' ? entry.minor : entry.major,
    tonality: camelot.letter === 'A' ? 'minor' : 'major',
  };
}

export function musicalKeyToCamelot(key: MusicalKey): CamelotKey | null {
  const entry = WHEEL.find((w) =>
    key.tonality === 'minor' ? w.minor === key.pitchClass : w.major === key.pitchClass,
  );
  if (!entry) return null;
  return { number: entry.number, letter: key.tonality === 'minor' ? 'A' : 'B' };
}

/** "8A" */
export function formatCamelot(camelot: CamelotKey): string {
  return `${camelot.number}${camelot.letter}`;
}

/** "A minor" — or "Ab minor" when the flat spelling reads better. */
export function formatMusicalKey(key: MusicalKey, preferFlat = false): string {
  const flat = SHARP_TO_FLAT[key.pitchClass];
  const note = preferFlat && flat ? flat : key.pitchClass;
  return `${note} ${key.tonality}`;
}

/** "8A · A minor" — the combined display from spec §12. */
export function formatCombined(key: MusicalKey): string {
  const camelot = musicalKeyToCamelot(key);
  return camelot ? `${formatCamelot(camelot)} · ${formatMusicalKey(key)}` : formatMusicalKey(key);
}

const CAMELOT_PATTERN = /^\s*(\d{1,2})\s*([AB])\s*$/i;

/** Parse "8A", "11b". Returns null rather than guessing. */
export function parseCamelot(input: string): CamelotKey | null {
  const match = CAMELOT_PATTERN.exec(input);
  if (!match) return null;
  const number = Number(match[1]);
  if (number < 1 || number > 12) return null;
  return { number, letter: match[2]!.toUpperCase() as 'A' | 'B' };
}

const MINOR_TOKENS = new Set(['M', 'MIN', 'MINOR', 'MOLL', 'AEOLIAN']);
const MAJOR_TOKENS = new Set(['MAJ', 'MAJOR', 'DUR', 'IONIAN', '']);

/**
 * Tolerant key parser for provider metadata, which is wildly inconsistent:
 * "A minor", "Am", "A min", "Abm", "F# Major", "Bb", "8A" all appear in the wild.
 *
 * Deliberately conservative: anything unrecognised returns null so the caller
 * records ANALYSE rather than inventing a key. Spec §8.
 */
export function parseKey(raw: string | null | undefined): MusicalKey | null {
  if (!raw) return null;
  const input = raw.trim();
  if (!input) return null;

  // Camelot notation first — unambiguous.
  const camelot = parseCamelot(input);
  if (camelot) return camelotToMusicalKey(camelot);

  const match = /^([A-Ga-g])\s*([#♯b♭]?)\s*(.*)$/.exec(input);
  if (!match) return null;

  const letter = match[1]!.toUpperCase();
  const accidentalRaw = match[2] ?? '';
  const accidental = accidentalRaw === '♯' ? '#' : accidentalRaw === '♭' ? 'b' : accidentalRaw;

  // Normalise the tonality token: strip separators and casing.
  const rest = match[3]!.replace(/[\s.\-_/]/g, '').toUpperCase();

  let tonality: Tonality;
  if (MINOR_TOKENS.has(rest)) tonality = 'minor';
  else if (MAJOR_TOKENS.has(rest)) tonality = 'major';
  else return null;

  const spelled = `${letter}${accidental}`.toUpperCase();
  const pitchClass =
    accidental === 'b'
      ? ENHARMONIC[spelled]
      : (spelled as PitchClass);

  if (!pitchClass) return null;
  // Guard against a bad sharp spelling slipping through (e.g. "G#" is fine, "H#" is not).
  const valid = WHEEL.some((w) => w.minor === pitchClass || w.major === pitchClass);
  if (!valid) {
    const remapped = ENHARMONIC[pitchClass];
    if (!remapped) return null;
    return { pitchClass: remapped, tonality };
  }
  return { pitchClass, tonality };
}

/** All 24 wheel positions, for rendering the key wheel. */
export function allCamelotKeys(): CamelotKey[] {
  const keys: CamelotKey[] = [];
  for (const entry of WHEEL) keys.push({ number: entry.number, letter: 'A' });
  for (const entry of WHEEL) keys.push({ number: entry.number, letter: 'B' });
  return keys;
}

export function camelotEquals(a: CamelotKey | undefined, b: CamelotKey | undefined): boolean {
  if (!a || !b) return false;
  return a.number === b.number && a.letter === b.letter;
}

/**
 * Continuous Camelot position for a fractional pitch class.
 *
 * The Camelot wheel is the circle of fifths, so adjacent numbers are a fifth
 * apart, NOT a semitone. Moving up one semitone therefore moves SEVEN positions
 * around the wheel (7 fifths = 1 semitone, mod 12). That is why pitching a
 * record for harmonic reasons is such a large move, and why a fractional pitch
 * shift has to be mapped through this rather than added to the wheel number.
 *
 * Returns a float in [1, 13) so a pitched record can be drawn between segments.
 */
export function continuousCamelotNumber(pitchClass: number, tonality: Tonality): number {
  // Anchor on a known pair: 8A = A minor (pitch class 9), 8B = C major (0).
  const anchorPitchClass = tonality === 'minor' ? 9 : 0;
  const offset = pitchClass - anchorPitchClass;
  // 7 wheel steps per semitone.
  const raw = 8 + offset * 7;
  // Wrap into [1, 13) keeping the fractional part.
  return ((((raw - 1) % 12) + 12) % 12) + 1;
}
