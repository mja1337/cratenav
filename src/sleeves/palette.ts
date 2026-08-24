import type { Settings, SleeveColor } from '@/domain/types';

export const DEFAULT_SLEEVE_COLORS: readonly SleeveColor[] = [
  { id: 'default-black', name: 'Black', hex: '#111111' },
  { id: 'default-white', name: 'White', hex: '#f5f5f5' },
  { id: 'default-teal', name: 'Teal', hex: '#008c8c' },
  { id: 'default-purple', name: 'Purple', hex: '#7a4bb3' },
] as const;

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

export function sleevePalette(settings: Pick<Settings, 'customSleeveColors'>): SleeveColor[] {
  const seen = new Set(DEFAULT_SLEEVE_COLORS.map((color) => color.id));
  const custom = (settings.customSleeveColors ?? []).filter((color) => {
    if (!color.id || !color.name.trim() || !isHexColor(color.hex) || seen.has(color.id)) return false;
    seen.add(color.id);
    return true;
  });
  return [...DEFAULT_SLEEVE_COLORS, ...custom];
}
