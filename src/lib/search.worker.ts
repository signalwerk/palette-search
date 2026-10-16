/// <reference lib="webworker" />
// Palette search and optimisation over OKLCH colours.
//
// Search: simulated annealing. Contrast constraints are hard (every candidate
// colour satisfies them); the ΔE constraint is optimised via an energy that
// sums squared shortfalls of every pair, in every checked vision type.
// Energy 0 ⇒ palette found.
//
// Optimise: hill climbing with small ("close-by") colour moves that keeps the
// palette valid and maximises the score (ΔE margin × contrast margin).

import {
  CVD_TYPES,
  contrastBlack,
  contrastWhite,
  deltaE2000,
  hex,
  inGamut,
  linearToLab,
  linearToOklch,
  linearToRgb,
  luminance,
  luminanceWindow,
  oklchToLinear,
  rgbToLinear,
  simulate,
  type RGB,
  type Vec3,
  type Vision,
} from './color'
import { styleById, type PaletteStyle } from './styles'
import type { Metrics, Palette, SearchParams, WorkerMessage, WorkerRequest } from './types'

const ALL_VISIONS: Vision[] = ['normal', ...CVD_TYPES]

interface Swatch {
  lch: Vec3
  rgb: RGB
  Y: number
  /** Lab per vision, indexed like ALL_VISIONS. */
  labs: Vec3[]
}

const post = (msg: WorkerMessage) => self.postMessage(msg)

const rand = (a: number, b: number) => a + Math.random() * (b - a)
const gauss = () => {
  const u = 1 - Math.random()
  const v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
const clamp = (v: number, [a, b]: [number, number]) => Math.min(b, Math.max(a, v))
const hueDist = (a: number, b: number) => {
  const d = Math.abs(((a - b) % 360) + 360) % 360
  return d > 180 ? 360 - d : d
}

function swatchFromRgb(rgb: RGB): Swatch {
  const lin = rgbToLinear(rgb)
  return {
    lch: linearToOklch(lin),
    rgb,
    Y: luminance(lin),
    labs: ALL_VISIONS.map((v) => linearToLab(simulate(lin, v))),
  }
}

const parseHex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
]

class Sampler {
  readonly baseHue: number
  private bands: [number, number][] | null
  private style: PaletteStyle
  private window: [number, number]

  constructor(style: PaletteStyle, window: [number, number], baseHue = Math.random() * 360) {
    this.style = style
    this.window = window
    this.baseHue = style.relative ? baseHue : 0
    this.bands = style.hues ? style.hues.map(([c, w]) => [(c + this.baseHue) % 360, w]) : null
  }

  private hueOk(H: number, C: number): boolean {
    if (!this.bands || C < 0.02) return true // near-greys have no meaningful hue
    return this.bands.some(([c, w]) => hueDist(H, c) <= w)
  }

  private randomHue(): number {
    if (!this.bands) return Math.random() * 360
    const [c, w] = this.bands[Math.floor(Math.random() * this.bands.length)]
    return (c + rand(-w, w) + 360) % 360
  }

  /** Validate an OKLCH candidate; returns a quantised swatch or null. */
  make(L: number, C: number, H: number): Swatch | null {
    const s = this.style
    if (L < s.L[0] || L > s.L[1] || C < s.C[0] || C > s.C[1]) return null
    if (!this.hueOk(H, C)) return null
    const raw = oklchToLinear(L, C, H)
    if (!inGamut(raw)) return null
    const sw = swatchFromRgb(linearToRgb(raw))
    if (sw.Y < this.window[0] || sw.Y > this.window[1]) return null
    return sw
  }

  random(attempts = 4000): Swatch | null {
    const s = this.style
    for (let k = 0; k < attempts; k++) {
      const sw = this.make(rand(s.L[0], s.L[1]), rand(s.C[0], s.C[1]), this.randomHue())
      if (sw) return sw
    }
    return null
  }

  /** Random nearby colour; `scale` ≈ 1 means large jumps, ≈ 0.05 means fine tuning. */
  mutate(sw: Swatch, scale: number): Swatch | null {
    const s = this.style
    for (let k = 0; k < 30; k++) {
      const L = clamp(sw.lch[0] + gauss() * 0.08 * scale, s.L)
      const C = clamp(sw.lch[1] + gauss() * 0.05 * scale, s.C)
      const H = (sw.lch[2] + gauss() * 40 * scale + 360) % 360
      const next = this.make(L, C, H)
      if (next && next.rgb.some((c, i) => c !== sw.rgb[i])) return next
    }
    return null
  }
}

const checkedVisions = (p: SearchParams) => (p.colorBlind ? [0, 1, 2, 3] : [0])

/**
 * Per-colour contrast margin: how far inside both contrast requirements it sits.
 * Requirements below 1 : 1 can't bind (every ratio is ≥ 1), so they count as 1.
 */
const colorContrastMargin = (Y: number, p: SearchParams) =>
  Math.min(
    contrastBlack(Y) / Math.max(1, p.minContrastBlack),
    contrastWhite(Y) / Math.max(1, p.minContrastWhite),
  )

function computeMetrics(swatches: Swatch[], p: SearchParams): Metrics {
  const visions = checkedVisions(p)
  const minDeltaE = { normal: Infinity, protanopia: Infinity, deuteranopia: Infinity, tritanopia: Infinity }
  let worst = { i: 0, j: 0, vision: 'normal' as Vision, deltaE: Infinity }
  for (let i = 0; i < swatches.length; i++) {
    for (let j = i + 1; j < swatches.length; j++) {
      ALL_VISIONS.forEach((v, vi) => {
        const d = deltaE2000(swatches[i].labs[vi], swatches[j].labs[vi])
        if (d < minDeltaE[v]) minDeltaE[v] = d
        if (visions.includes(vi) && d < worst.deltaE) worst = { i, j, vision: v, deltaE: d }
      })
    }
  }
  const Ys = swatches.map((s) => s.Y)
  const deltaEMargin = worst.deltaE / Math.max(1, p.minDeltaE)
  const contrastMargin = Math.min(...Ys.map((Y) => colorContrastMargin(Y, p)))
  return {
    minDeltaE,
    worst,
    minContrastBlack: contrastBlack(Math.min(...Ys)),
    minContrastWhite: contrastWhite(Math.max(...Ys)),
    deltaEMargin,
    contrastMargin,
    score: deltaEMargin * contrastMargin,
  }
}

function toPalette(swatches: Swatch[], p: SearchParams, baseHue: number): Palette {
  // Chromatic colours by hue, then neutrals by lightness.
  const list = [...swatches].sort((a, b) => {
    const na = a.lch[1] < 0.03
    const nb = b.lch[1] < 0.03
    if (na !== nb) return na ? 1 : -1
    return na ? b.lch[0] - a.lch[0] : a.lch[2] - b.lch[2]
  })
  return { colors: list.map((s) => hex(s.rgb)), baseHue, metrics: computeMetrics(list, p) }
}

function setup(p: SearchParams) {
  const window = luminanceWindow(p.minContrastBlack, p.minContrastWhite)
  if (!window) post({ type: 'error', message: 'The two contrast constraints exclude every colour. Lower one of them.' })
  return window
}

function search(p: SearchParams) {
  const window = setup(p)
  if (!window) return
  const style = styleById(p.styleId)
  const n = p.colorCount
  const visions = checkedVisions(p)
  const target = p.minDeltaE
  const start = performance.now()
  const ITER_PER_RESTART = 2500 + n * 600

  let found = 0

  // pair shortfall energy contributed by swatch k against all others
  const pairEnergy = (sw: Swatch[], k: number, cand: Swatch) => {
    let e = 0
    for (let j = 0; j < sw.length; j++) {
      if (j === k) continue
      for (const vi of visions) {
        const short = target - deltaE2000(cand.labs[vi], sw[j].labs[vi])
        if (short > 0) e += short * short
      }
    }
    return e
  }

  while (found < p.paletteCount) {
    const sampler = new Sampler(style, window)
    const swatches: Swatch[] = []
    for (let k = 0; k < n; k++) {
      const sw = sampler.random()
      if (!sw) {
        post({
          type: 'error',
          message: `No colour in the “${style.label}” style satisfies the contrast constraints. Relax the contrast or pick another style.`,
        })
        return
      }
      swatches.push(sw)
    }
    let energy = 0
    for (let k = 0; k < n; k++) energy += pairEnergy(swatches, k, swatches[k])
    energy /= 2

    for (let it = 0; it < ITER_PER_RESTART && energy > 0; it++) {
      const temp = 1 - it / ITER_PER_RESTART // 1 → 0

      // Prefer moving one of the colours involved in the worst pair.
      let k: number
      if (Math.random() < 0.6) {
        const w = worstPair(swatches, visions)
        k = Math.random() < 0.5 ? w[0] : w[1]
      } else k = Math.floor(Math.random() * n)

      const cand =
        Math.random() < 0.08
          ? sampler.random(400)
          : (sampler.mutate(swatches[k], 0.15 + temp) ?? sampler.random(200))
      if (!cand) continue
      const delta = pairEnergy(swatches, k, cand) - pairEnergy(swatches, k, swatches[k])
      const T = temp * temp * target * target * 0.05 + 1e-9
      if (delta <= 0 || Math.random() < Math.exp(-delta / T)) {
        swatches[k] = cand
        energy += delta
        if (energy < 1e-9) energy = 0
      }

      if ((it & 255) === 0 && p.timeLimitSec > 0 && performance.now() - start > p.timeLimitSec * 1000) {
        post({ type: 'done', reason: 'timeout' })
        return
      }
    }

    if (energy === 0) {
      found++
      post({ type: 'found', palette: toPalette(swatches, p, sampler.baseHue) })
    }
  }
  post({ type: 'done', reason: 'complete' })
}

function worstPair(sw: Swatch[], visions: number[]): [number, number] {
  let best = Infinity
  let pair: [number, number] = [0, 1]
  for (let i = 0; i < sw.length; i++) {
    for (let j = i + 1; j < sw.length; j++) {
      for (const vi of visions) {
        const d = deltaE2000(sw[i].labs[vi], sw[j].labs[vi])
        if (d < best) {
          best = d
          pair = [i, j]
        }
      }
    }
  }
  return pair
}

const OPTIMISE_MS = 2000

function optimise(p: SearchParams, palette: Palette) {
  const window = setup(p)
  if (!window) return
  const sampler = new Sampler(styleById(p.styleId), window, palette.baseHue)
  const swatches = palette.colors.map((c) => swatchFromRgb(parseHex(c)))
  const n = swatches.length
  let metrics = computeMetrics(swatches, p)
  let best = { swatches: [...swatches], metrics }
  const start = performance.now()

  // Low-temperature annealing on log(score): small setbacks are allowed so the
  // palette can slide off plateaus where several pairs are tied for worst.
  for (;;) {
    const progress = (performance.now() - start) / OPTIMISE_MS
    if (progress >= 1) break
    const scale = 0.2 * (1 - progress) + 0.02
    const T = 0.03 * (1 - progress) ** 2 + 1e-6

    // Move the colours that limit the score most often.
    const r = Math.random()
    let k: number
    if (r < 0.5) k = Math.random() < 0.5 ? metrics.worst.i : metrics.worst.j
    else if (r < 0.7) {
      k = 0
      for (let i = 1; i < n; i++)
        if (colorContrastMargin(swatches[i].Y, p) < colorContrastMargin(swatches[k].Y, p)) k = i
    } else k = Math.floor(Math.random() * n)

    const cand = sampler.mutate(swatches[k], scale)
    if (!cand) continue
    const prev = swatches[k]
    swatches[k] = cand
    const next = computeMetrics(swatches, p)
    const delta = Math.log(next.score) - Math.log(metrics.score)
    if (next.worst.deltaE >= p.minDeltaE && (delta >= 0 || Math.random() < Math.exp(delta / T))) {
      metrics = next
      if (metrics.score > best.metrics.score) best = { swatches: [...swatches], metrics }
    } else swatches[k] = prev
  }

  post({ type: 'optimised', palette: toPalette(best.swatches, p, palette.baseHue) })
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  if (req.type === 'search') search(req.params)
  else optimise(req.params, req.palette)
}
