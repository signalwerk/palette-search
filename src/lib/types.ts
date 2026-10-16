import type { Vision } from './color'

export interface SearchParams {
  paletteCount: number
  colorCount: number
  minDeltaE: number
  minContrastBlack: number
  minContrastWhite: number
  colorBlind: boolean
  styleId: string
  timeLimitSec: number
}

export interface Metrics {
  /** Smallest pairwise CIEDE2000 per vision type. */
  minDeltaE: Record<Vision, number>
  /** Pair (indices) and vision that produced the overall worst ΔE among the checked visions. */
  worst: { i: number; j: number; vision: Vision; deltaE: number }
  minContrastBlack: number
  minContrastWhite: number
  /** Worst ΔE ÷ required ΔE (≥ 1 when valid). */
  deltaEMargin: number
  /** Worst per-colour min(contrast vs black ÷ required, contrast vs white ÷ required). */
  contrastMargin: number
  /** deltaEMargin × contrastMargin — higher is better. */
  score: number
}

export interface Palette {
  colors: string[]
  /** Base hue of relative styles (analogous, triadic, …) so optimising stays in-style. */
  baseHue: number
  metrics: Metrics
}

export type WorkerRequest =
  | { type: 'search'; params: SearchParams }
  | { type: 'optimise'; params: SearchParams; palette: Palette }

export type WorkerMessage =
  | { type: 'found'; palette: Palette }
  | { type: 'done'; reason: 'complete' | 'timeout' }
  | { type: 'optimised'; palette: Palette }
  | { type: 'error'; message: string }
