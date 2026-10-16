// "Artistic choices": each style constrains where colours may live in OKLCH.
// Hue bands are [centre, half-width] in degrees; `relative` bands are offset
// by a random base hue that is chosen once per palette.

export interface PaletteStyle {
  id: string
  label: string
  description: string
  L: [number, number]
  C: [number, number]
  hues?: [number, number][]
  relative?: boolean
}

export const STYLES: PaletteStyle[] = [
  { id: 'any', label: 'Anything goes', description: 'Full sRGB gamut, no restriction.', L: [0, 1], C: [0, 0.37] },
  { id: 'vibrant', label: 'Vibrant', description: 'Saturated, punchy colours.', L: [0.45, 0.9], C: [0.14, 0.37] },
  { id: 'pastel', label: 'Pastel', description: 'Light and soft.', L: [0.78, 0.96], C: [0.03, 0.12] },
  { id: 'muted', label: 'Muted / dusty', description: 'Low chroma, mid lightness.', L: [0.4, 0.82], C: [0.02, 0.09] },
  { id: 'jewel', label: 'Jewel tones', description: 'Deep, rich, saturated.', L: [0.3, 0.62], C: [0.1, 0.3] },
  { id: 'neon', label: 'Neon', description: 'Bright and very saturated.', L: [0.7, 0.97], C: [0.18, 0.37] },
  { id: 'dark', label: 'Dark & moody', description: 'Low lightness.', L: [0.15, 0.45], C: [0.02, 0.2] },
  {
    id: 'earthy',
    label: 'Earthy',
    description: 'Browns, ochres, olives, terracotta.',
    L: [0.3, 0.8],
    C: [0.03, 0.14],
    hues: [[70, 55], [145, 20]],
  },
  { id: 'warm', label: 'Warm', description: 'Reds, oranges, yellows, magentas.', L: [0.3, 0.95], C: [0.05, 0.37], hues: [[45, 65]] },
  { id: 'cool', label: 'Cool', description: 'Greens, cyans, blues, violets.', L: [0.3, 0.95], C: [0.05, 0.37], hues: [[225, 75]] },
  {
    id: 'analogous',
    label: 'Analogous',
    description: 'Neighbouring hues around a random base hue.',
    L: [0.2, 0.95],
    C: [0.05, 0.37],
    hues: [[0, 45]],
    relative: true,
  },
  {
    id: 'complementary',
    label: 'Complementary',
    description: 'Two opposite hue families.',
    L: [0.2, 0.95],
    C: [0.05, 0.37],
    hues: [[0, 25], [180, 25]],
    relative: true,
  },
  {
    id: 'split',
    label: 'Split complementary',
    description: 'A base hue and the two neighbours of its complement.',
    L: [0.2, 0.95],
    C: [0.05, 0.37],
    hues: [[0, 20], [150, 15], [210, 15]],
    relative: true,
  },
  {
    id: 'triadic',
    label: 'Triadic',
    description: 'Three hue families 120° apart.',
    L: [0.2, 0.95],
    C: [0.05, 0.37],
    hues: [[0, 20], [120, 20], [240, 20]],
    relative: true,
  },
  {
    id: 'mono',
    label: 'Monochromatic',
    description: 'A single hue family, varied in lightness and chroma.',
    L: [0.1, 0.97],
    C: [0.02, 0.37],
    hues: [[0, 12]],
    relative: true,
  },
]

export const styleById = (id: string): PaletteStyle => STYLES.find((s) => s.id === id) ?? STYLES[0]
