import type { CamelotKey, KeyNotation, Tonality } from '@/domain/types';
import {
  camelotEquals,
  camelotToMusicalKey,
  continuousCamelotNumber,
  formatCamelot,
  formatMusicalKey,
} from '@/harmonic/camelot';
import { compareKeys, compatibleKeys } from '@/harmonic/compatibility';

/**
 * Interactive harmonic mixing wheel. Spec §13.
 *
 * Two notations over the same geometry, toggled rather than shown together to
 * avoid clutter (spec §12):
 *   Camelot   1A-12A inner ring, 1B-12B outer ring
 *   Musical   the equivalent minor and major key names
 *
 * Rendered as SVG so it scales cleanly from a phone to a desktop pane, and is
 * reusable in track detail, set planning, bag analysis and live mode.
 */

export interface KeyWheelOptions {
  /** The key to centre the harmonic relationships on. */
  selected?: CamelotKey | undefined;
  /** A second track to compare against the selected/current key. */
  comparison?: CamelotKey | undefined;
  notation: KeyNotation;
  /** Called when a segment is activated. */
  onSelect?: (key: CamelotKey) => void;
  size?: number;
  /**
   * Coverage mode: how many tracks sit in each key, keyed by Camelot label
   * ("8A"). Segments are shaded by density instead of by compatibility, which
   * is how spec §19 wants a bag's key spread visualised.
   */
  counts?: ReadonlyMap<string, number> | undefined;
  /** Centre readout override, e.g. "18/24" for coverage. */
  centreLabel?: string | undefined;
  /**
   * Effective tonal centre of a pitched record, as a continuous pitch class.
   * Drawn as a marker that can sit BETWEEN segments, because vinyl pitch is
   * continuous and must not be snapped to a discrete key. Spec v1.1 §17.
   */
  effectivePitchClass?: number | undefined;
  effectiveTonality?: Tonality | undefined;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Annular sector path, angles in degrees clockwise from 12 o'clock. */
function sectorPath(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number,
): string {
  const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const point = (radius: number, angle: number) => ({
    x: cx + radius * Math.cos(toRad(angle)),
    y: cy + radius * Math.sin(toRad(angle)),
  });

  const outerStart = point(outerR, startAngle);
  const outerEnd = point(outerR, endAngle);
  const innerEnd = point(innerR, endAngle);
  const innerStart = point(innerR, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
    `L ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

function midpoint(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  const rad = ((angle - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

function labelFor(key: CamelotKey, notation: KeyNotation): string {
  if (notation === 'camelot') return formatCamelot(key);
  const musical = camelotToMusicalKey(key);
  if (!musical) return formatCamelot(key);
  // Compact on the wheel: "Am" / "C". The full name is in the title attribute.
  return musical.tonality === 'minor' ? `${musical.pitchClass}m` : musical.pitchClass;
}

function accessibleName(key: CamelotKey): string {
  const musical = camelotToMusicalKey(key);
  return musical ? `${formatCamelot(key)}, ${formatMusicalKey(musical)}` : formatCamelot(key);
}

/**
 * Marker for a pitched record's effective tonal centre. Spec v1.1 §17.
 *
 * Deliberately drawn at a continuous angle rather than snapped to a segment:
 * a record at +4% genuinely sits between two keys, and pretending otherwise is
 * the mistake the whole patch exists to prevent.
 */
function appendEffectiveMarker(
  svg: SVGSVGElement,
  centre: number,
  radius: number,
  options: KeyWheelOptions,
): void {
  if (options.effectivePitchClass === undefined) return;

  const tonality = options.effectiveTonality ?? 'minor';
  const position = continuousCamelotNumber(options.effectivePitchClass, tonality);
  const angle = (position - 1) * 30;
  const rad = ((angle - 90) * Math.PI) / 180;

  const outer = radius + 1;
  const inner = radius - 16;
  const x1 = centre + inner * Math.cos(rad);
  const y1 = centre + inner * Math.sin(rad);
  const x2 = centre + outer * Math.cos(rad);
  const y2 = centre + outer * Math.sin(rad);

  const group = document.createElementNS(SVG_NS, 'g');

  // A needle plus a dot: shape as well as colour, so it survives greyscale.
  const needle = document.createElementNS(SVG_NS, 'line');
  needle.setAttribute('x1', x1.toFixed(2));
  needle.setAttribute('y1', y1.toFixed(2));
  needle.setAttribute('x2', x2.toFixed(2));
  needle.setAttribute('y2', y2.toFixed(2));
  needle.setAttribute('stroke', 'var(--state-verify)');
  needle.setAttribute('stroke-width', '3');
  needle.setAttribute('stroke-linecap', 'round');
  group.append(needle);

  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', x2.toFixed(2));
  dot.setAttribute('cy', y2.toFixed(2));
  dot.setAttribute('r', '4');
  dot.setAttribute('fill', 'var(--state-verify)');
  group.append(dot);

  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = `Effective position when pitched: between wheel positions (${position.toFixed(2)})`;
  group.append(title);

  group.setAttribute('role', 'img');
  group.setAttribute('aria-label', title.textContent);
  svg.append(group);
}

export function keyWheel(options: KeyWheelOptions): SVGSVGElement {
  const size = options.size ?? 300;
  const centre = size / 2;
  const outerRadius = centre - 4;
  const midRadius = centre * 0.66;
  const innerRadius = centre * 0.34;
  const segmentAngle = 30;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('role', 'group');
  svg.setAttribute(
    'aria-label',
    options.notation === 'camelot' ? 'Camelot wheel' : 'Musical key wheel',
  );
  svg.style.maxWidth = `${size}px`;
  svg.style.display = 'block';
  svg.style.margin = '0 auto';

  const compatible = options.selected ? compatibleKeys(options.selected) : [];

  const rings: { letter: 'A' | 'B'; inner: number; outer: number }[] = [
    // Minor ring sits inside, major outside, matching the usual Camelot layout.
    { letter: 'A', inner: innerRadius, outer: midRadius },
    { letter: 'B', inner: midRadius, outer: outerRadius },
  ];

  for (const ring of rings) {
    for (let number = 1; number <= 12; number += 1) {
      const key: CamelotKey = { number, letter: ring.letter };
      const startAngle = (number - 1) * segmentAngle - segmentAngle / 2;
      const endAngle = startAngle + segmentAngle;

      const isSelected = camelotEquals(options.selected, key);
      const isComparison = camelotEquals(options.comparison, key);
      const relation = options.selected ? compareKeys(options.selected, key) : null;
      const isCompatible =
        !isSelected && compatible.some((candidate) => camelotEquals(candidate, key));

      const count = options.counts?.get(formatCamelot(key));
      const isCoverage = options.counts !== undefined;

      const group = document.createElementNS(SVG_NS, 'g');

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute(
        'd',
        sectorPath(centre, centre, ring.inner, ring.outer, startAngle, endAngle),
      );

      if (isCoverage) {
        // Density shading. Opacity rather than separate colours so an empty key
        // reads as genuinely absent rather than as another category.
        const max = Math.max(1, ...[...(options.counts?.values() ?? [])]);
        const share = count ? 0.25 + 0.75 * (count / max) : 0;
        path.setAttribute('fill', count ? 'var(--accent)' : 'var(--bg-raised-2)');
        path.setAttribute('fill-opacity', String(share || 1));
        path.setAttribute('stroke', count ? 'var(--accent)' : 'var(--border)');
        path.setAttribute('stroke-width', '1');
      } else {
        path.setAttribute(
          'fill',
          isSelected
            ? 'var(--accent)'
            : isComparison
              ? 'var(--state-ready)'
            : isCompatible
              ? 'var(--accent-soft)'
              : 'var(--bg-raised-2)',
        );
        path.setAttribute('stroke', isSelected || isCompatible ? 'var(--accent)' : isComparison ? 'var(--state-ready)' : 'var(--border)');
        path.setAttribute('stroke-width', isSelected || isComparison ? '3' : '1');
      }
      group.append(path);

      const label = document.createElementNS(SVG_NS, 'text');
      const position = midpoint(centre, centre, (ring.inner + ring.outer) / 2, startAngle + segmentAngle / 2);
      label.setAttribute('x', position.x.toFixed(2));
      label.setAttribute('y', position.y.toFixed(2));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.setAttribute('font-size', ring.letter === 'A' ? '11' : '12');
      label.setAttribute('font-weight', isSelected ? '700' : '600');
      label.setAttribute('font-family', 'var(--font-mono)');
      label.setAttribute(
        'fill',
        isCoverage
          ? count
            ? 'var(--text)'
            : 'var(--text-faint)'
          : isSelected
            ? 'var(--accent-ink)'
            : isComparison
              ? 'var(--bg)'
            : isCompatible
              ? 'var(--accent)'
              : 'var(--text-muted)',
      );
      label.setAttribute('pointer-events', 'none');
      label.textContent = labelFor(key, options.notation);
      group.append(label);

      // A selected or compatible segment is marked by fill, outline weight AND
      // a text cue in its accessible name, never by colour alone. Spec §42, §43.
      // Coverage mode states the count in words, so the shading is never the
      // only carrier of meaning. Spec §42, §43.
      const description = isCoverage
        ? `${accessibleName(key)}: ${count ?? 0} ${count === 1 ? 'track' : 'tracks'}`
        : isSelected
          ? `${accessibleName(key)}, current key${isComparison ? ' and compared track' : ''}`
          : isComparison
            ? `${accessibleName(key)}, compared track key`
          : isCompatible
            ? `${accessibleName(key)}, compatible (${relation?.label ?? ''})`
            : accessibleName(key);

      if (options.onSelect) {
        group.setAttribute('role', 'button');
        group.setAttribute('tabindex', '0');
        group.setAttribute('aria-label', description);
        group.style.cursor = 'pointer';
        const activate = () => options.onSelect?.(key);
        group.addEventListener('click', activate);
        group.addEventListener('keydown', (event) => {
          const key = (event as KeyboardEvent).key;
          if (key === 'Enter' || key === ' ') {
            event.preventDefault();
            activate();
          }
        });
      } else {
        group.setAttribute('role', 'img');
        group.setAttribute('aria-label', description);
      }

      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = description;
      group.append(title);

      svg.append(group);
    }
  }

  appendEffectiveMarker(svg, centre, outerRadius, options);

  // Centre readout, so the wheel is self-explanatory at a glance.
  const centreLabel = document.createElementNS(SVG_NS, 'text');
  centreLabel.setAttribute('x', String(centre));
  centreLabel.setAttribute('y', String(centre));
  centreLabel.setAttribute('text-anchor', 'middle');
  centreLabel.setAttribute('dominant-baseline', 'central');
  centreLabel.setAttribute('font-size', '15');
  centreLabel.setAttribute('font-weight', '700');
  centreLabel.setAttribute('font-family', 'var(--font-mono)');
  centreLabel.setAttribute(
    'fill',
    options.selected || options.centreLabel ? 'var(--text)' : 'var(--text-faint)',
  );
  centreLabel.setAttribute('pointer-events', 'none');
  centreLabel.textContent =
    options.centreLabel ??
    (options.selected ? labelFor(options.selected, options.notation) : 'no key');
  svg.append(centreLabel);

  return svg;
}
