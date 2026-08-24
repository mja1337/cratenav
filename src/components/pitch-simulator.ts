import type { KeyNotation, MusicalKey } from '@/domain/types';
import type { DeckProfile } from '@/pitch/deck';
import { describePlayback } from '@/pitch/calculations';
import { formatCamelot, formatMusicalKey, musicalKeyToCamelot } from '@/harmonic/camelot';
import { keyWheel } from './key-wheel';
import { clear, h } from '@/utils/dom';

/**
 * Pitch simulator. Spec v1.1 §16.
 *
 * Answers "what happens to this record if I pitch it?" — the tempo it reaches,
 * how far its musical pitch moves, and where that leaves it on the wheel. The
 * underlying calculation is never snapped to a whole key (§16), so the readout
 * shows both the nearest key and the cents it is away from it.
 */

export interface PitchSimulatorOptions {
  nativeBpm?: number | undefined;
  nativeKey?: MusicalKey | undefined;
  deck: DeckProfile;
  notation: KeyNotation;
  /** Starting pitch. */
  initialPitchPercent?: number;
  /** Notified as the user drags, for callers that want to react. */
  onChange?: (pitchPercent: number) => void;
  showWheel?: boolean;
}

export function pitchSimulator(options: PitchSimulatorOptions): HTMLElement {
  const { deck } = options;
  let pitchPercent = options.initialPitchPercent ?? 0;

  const element = h('div', { class: 'card stack stack--tight' });
  const readout = h('div', { class: 'stack stack--tight' });

  const slider = h('input', {
    id: 'pitch-simulator-slider',
    name: 'pitchSimulatorSlider',
    class: 'pitch-slider',
    type: 'range',
    min: String(deck.pitchRangeMin),
    max: String(deck.pitchRangeMax),
    step: '0.1',
    value: String(pitchPercent),
    'aria-label': 'Pitch percentage',
  }) as HTMLInputElement;

  const numberInput = h('input', {
    id: 'pitch-simulator-exact',
    name: 'pitchSimulatorExact',
    class: 'input',
    type: 'number',
    min: String(deck.pitchRangeMin),
    max: String(deck.pitchRangeMax),
    step: '0.1',
    value: String(pitchPercent),
    inputmode: 'decimal',
    'aria-label': 'Pitch percentage, exact',
    style: { maxWidth: '110px' },
  }) as HTMLInputElement;

  const apply = (value: number, source: 'slider' | 'number') => {
    // Clamp to the deck, because a slider cannot express what the deck cannot do.
    pitchPercent = Math.max(deck.pitchRangeMin, Math.min(deck.pitchRangeMax, value));
    if (source !== 'slider') slider.value = String(pitchPercent);
    if (source !== 'number') numberInput.value = String(Math.round(pitchPercent * 10) / 10);
    render();
    options.onChange?.(pitchPercent);
  };

  slider.addEventListener('input', () => apply(Number(slider.value), 'slider'));
  numberInput.addEventListener('input', () => {
    const value = Number(numberInput.value);
    if (Number.isFinite(value)) apply(value, 'number');
  });

  function render(): void {
    clear(readout);

    const state = describePlayback({
      nativeBpm: options.nativeBpm ?? 0,
      nativeKey: options.nativeKey,
      pitchPercent,
      mode: deck.mode,
    });

    const nativeCamelot = options.nativeKey
      ? musicalKeyToCamelot(options.nativeKey)
      : null;

    const signed = (value: number, digits = 2) =>
      `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

    readout.append(
      h(
        'div',
        { class: 'detail-grid' },
        detail('Native', [
          options.nativeBpm !== undefined ? `${options.nativeBpm} BPM` : 'BPM unknown',
          nativeCamelot && options.nativeKey
            ? `${formatCamelot(nativeCamelot)} · ${formatMusicalKey(options.nativeKey)}`
            : 'key unknown',
        ].join('\n')),
        detail('Pitch', `${signed(pitchPercent, 1)}%`),
        detail(
          'Playback',
          options.nativeBpm !== undefined ? `${state.playbackBpm.toFixed(1)} BPM` : '—',
        ),
        detail(
          'Pitch shift',
          deck.mode === 'KEY_LOCK'
            ? 'none (key lock)'
            : `${signed(state.pitchShiftSemitones)} semitone\n${signed(state.pitchShiftCents, 0)} cents`,
        ),
        ...(options.nativeKey && deck.mode === 'VINYL'
          ? [
              detail(
                'Effective key',
                state.effectiveCamelotApproximation && state.effectiveKeyApproximation
                  ? `${formatCamelot(state.effectiveCamelotApproximation)} · ${formatMusicalKey(state.effectiveKeyApproximation)}`
                  : '—',
              ),
              detail(
                'Off that key by',
                `${state.harmonicDeviationCents > 0 ? '+' : ''}${state.harmonicDeviationCents} cents`,
              ),
            ]
          : []),
      ),
    );

    if (options.showWheel !== false && options.nativeKey) {
      readout.append(
        keyWheel({
          notation: options.notation,
          selected: nativeCamelot ?? undefined,
          size: 260,
          effectivePitchClass: deck.mode === 'VINYL' ? state.effectivePitchClass : undefined,
          effectiveTonality: options.nativeKey.tonality,
          centreLabel: `${signed(pitchPercent, 1)}%`,
        }),
        h('p', {
          class: 'field__hint',
          text:
            deck.mode === 'KEY_LOCK'
              ? 'Key lock is on, so the tonal centre does not move with the tempo.'
              : 'The amber needle is where the record actually sits once pitched. The wheel is the circle of fifths, so one semitone of pitch moves it seven positions.',
        }),
      );
    }
  }

  element.append(
    h(
      'div',
      { class: 'row' },
      h('h2', { class: 'section-title', text: 'Pitch simulator', style: { flex: '1' } }),
      h('span', { class: 'chip', text: deck.name }),
    ),
    h(
      'div',
      { class: 'row' },
      slider,
      numberInput,
      h('button', {
        class: 'button button--small button--ghost',
        type: 'button',
        text: 'Reset',
        onclick: () => apply(0, 'number'),
      }),
    ),
    readout,
  );

  render();
  return element;
}

function detail(label: string, value: string): HTMLElement {
  return h(
    'div',
    { class: 'detail-item' },
    h('div', { class: 'detail-item__label', text: label }),
    h('div', {
      class: 'detail-item__value',
      style: { whiteSpace: 'pre-line', fontFamily: 'var(--font-mono)', fontSize: '0.875rem' },
      text: value,
    }),
  );
}
