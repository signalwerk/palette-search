// Colour science helpers: sRGB, OKLab/OKLCH, CIELAB, CIEDE2000, WCAG contrast
// and colour-vision-deficiency simulation (Machado et al. 2009, severity 1.0).

export type RGB = [number, number, number] // 0..255 integers
export type Vec3 = [number, number, number]

export const srgbToLinear = (c: number): number => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export const linearToSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, c)) * 255)
}

export const rgbToLinear = (rgb: RGB): Vec3 => [
  srgbToLinear(rgb[0]),
  srgbToLinear(rgb[1]),
  srgbToLinear(rgb[2]),
]

export const linearToRgb = (lin: Vec3): RGB => [
  linearToSrgb(lin[0]),
  linearToSrgb(lin[1]),
  linearToSrgb(lin[2]),
]

export const hex = (rgb: RGB): string =>
  '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('')

// ---------- OKLCH ----------

/** OKLCH → linear sRGB (may be out of gamut). Hue in degrees. */
export function oklchToLinear(L: number, C: number, H: number): Vec3 {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

export function linearToOklch(lin: Vec3): Vec3 {
  const [r, g, b] = lin
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const C = Math.sqrt(A * A + B * B)
  let H = (Math.atan2(B, A) * 180) / Math.PI
  if (H < 0) H += 360
  return [L, C, H]
}

export const inGamut = (lin: Vec3, eps = 1e-4): boolean =>
  lin.every((v) => v >= -eps && v <= 1 + eps)

// ---------- Luminance & contrast ----------

export const luminance = (lin: Vec3): number =>
  0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]

/** WCAG 2.x contrast ratio against black (Y=0) and white (Y=1). */
export const contrastBlack = (Y: number): number => (Y + 0.05) / 0.05
export const contrastWhite = (Y: number): number => 1.05 / (Y + 0.05)

/**
 * The relative-luminance window allowed by the two contrast constraints.
 * Returns null when no colour can satisfy both.
 */
export function luminanceWindow(minBlack: number, minWhite: number): [number, number] | null {
  const lo = Math.max(0, minBlack * 0.05 - 0.05)
  const hi = Math.min(1, 1.05 / Math.max(1, minWhite) - 0.05)
  return lo <= hi ? [lo, hi] : null
}

// ---------- CIELAB / CIEDE2000 ----------

const fLab = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)

export function linearToLab(lin: Vec3): Vec3 {
  const [r, g, b] = lin
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const fx = fLab(X)
  const fy = fLab(Y)
  const fz = fLab(Z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const deg = Math.PI / 180

export function deltaE2000(lab1: Vec3, lab2: Vec3): number {
  const [L1, a1, b1] = lab1
  const [L2, a2, b2] = lab2
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2
  const Cbar7 = Math.pow(Cbar, 7)
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))) // 25^7
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const h1p = C1p === 0 ? 0 : (Math.atan2(b1, a1p) / deg + 360) % 360
  const h2p = C2p === 0 ? 0 : (Math.atan2(b2, a2p) / deg + 360) % 360

  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * deg) / 2)

  const Lbp = (L1 + L2) / 2
  const Cbp = (C1p + C2p) / 2
  let hbp = h1p + h2p
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2
    else hbp = (h1p + h2p) / 2
  }
  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * deg) +
    0.24 * Math.cos(2 * hbp * deg) +
    0.32 * Math.cos((3 * hbp + 6) * deg) -
    0.2 * Math.cos((4 * hbp - 63) * deg)
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2))
  const Cbp7 = Math.pow(Cbp, 7)
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + 6103515625))
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2))
  const Sc = 1 + 0.045 * Cbp
  const Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin(2 * dTheta * deg) * Rc

  const l = dLp / Sl
  const c = dCp / Sc
  const h = dHp / Sh
  return Math.sqrt(l * l + c * c + h * h + Rt * c * h)
}

// ---------- Colour vision deficiency ----------

export type Vision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia'

export const CVD_TYPES: Exclude<Vision, 'normal'>[] = ['protanopia', 'deuteranopia', 'tritanopia']

const CVD_MATRICES: Record<Exclude<Vision, 'normal'>, number[]> = {
  protanopia: [
    0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
  ],
  deuteranopia: [
    0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
  ],
  tritanopia: [
    1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
  ],
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function simulate(lin: Vec3, vision: Vision): Vec3 {
  if (vision === 'normal') return lin
  const m = CVD_MATRICES[vision]
  const [r, g, b] = lin
  return [
    clamp01(m[0] * r + m[1] * g + m[2] * b),
    clamp01(m[3] * r + m[4] * g + m[5] * b),
    clamp01(m[6] * r + m[7] * g + m[8] * b),
  ]
}
