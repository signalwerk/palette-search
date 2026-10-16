import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CVD_TYPES,
  contrastBlack,
  contrastWhite,
  hex,
  linearToRgb,
  luminance,
  luminanceWindow,
  rgbToLinear,
  simulate,
  type RGB,
  type Vision,
} from './lib/color'
import { STYLES, styleById } from './lib/styles'
import type { Palette, SearchParams, WorkerMessage, WorkerRequest } from './lib/types'
import './App.css'

const DEFAULTS: SearchParams = {
  paletteCount: 6,
  colorCount: 5,
  minDeltaE: 15,
  minContrastBlack: 3,
  minContrastWhite: 3,
  colorBlind: true,
  styleId: 'any',
  timeLimitSec: 60,
}

type NumericKey = Exclude<keyof SearchParams, 'colorBlind' | 'styleId'>

interface NumberSpec {
  key: NumericKey
  label: string
  min: number
  max: number
  step: number
  suffix?: string
}

const NUMBER_FIELDS: NumberSpec[] = [
  { key: 'paletteCount', label: 'Palettes to find', min: 1, max: 100, step: 1 },
  { key: 'colorCount', label: 'Colours per palette', min: 2, max: 16, step: 1 },
  { key: 'minDeltaE', label: 'Minimum ΔE (CIEDE2000)', min: 0, max: 100, step: 0.5 },
  { key: 'minContrastBlack', label: 'Min. contrast vs black', min: 0, max: 21, step: 0.1, suffix: ': 1' },
  { key: 'minContrastWhite', label: 'Min. contrast vs white', min: 0, max: 21, step: 0.1, suffix: ': 1' },
]
const TIME_FIELD: NumberSpec = {
  key: 'timeLimitSec',
  label: 'Give up after (seconds, 0 = never)',
  min: 0,
  max: 3600,
  step: 5,
}

// ---------- URL state ----------

const URL_KEYS: Record<keyof SearchParams, string> = {
  paletteCount: 'palettes',
  colorCount: 'colors',
  minDeltaE: 'de',
  minContrastBlack: 'black',
  minContrastWhite: 'white',
  colorBlind: 'cvd',
  styleId: 'style',
  timeLimitSec: 'limit',
}

function paramsFromUrl(): SearchParams {
  const q = new URLSearchParams(window.location.search)
  const p = { ...DEFAULTS }
  for (const f of [...NUMBER_FIELDS, TIME_FIELD]) {
    const v = parseFloat(q.get(URL_KEYS[f.key]) ?? '')
    if (Number.isFinite(v)) p[f.key] = Math.min(f.max, Math.max(f.min, v))
  }
  const cvd = q.get(URL_KEYS.colorBlind)
  if (cvd !== null) p.colorBlind = cvd === '1' || cvd === 'true'
  const style = q.get(URL_KEYS.styleId)
  if (style && STYLES.some((s) => s.id === style)) p.styleId = style
  return p
}

function paramsToUrl(p: SearchParams) {
  const q = new URLSearchParams(window.location.search)
  for (const key of Object.keys(URL_KEYS) as (keyof SearchParams)[]) {
    const v = p[key]
    q.set(URL_KEYS[key], typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  }
  window.history.replaceState(null, '', `${window.location.pathname}?${q}${window.location.hash}`)
}

// ---------- helpers ----------

const VISION_LABEL: Record<Vision, string> = {
  normal: 'Normal vision',
  protanopia: 'Protanopia',
  deuteranopia: 'Deuteranopia',
  tritanopia: 'Tritanopia',
}

type Status = 'idle' | 'running' | 'done' | 'timeout' | 'stopped' | 'error'

interface Entry {
  id: number
  palette: Palette
  /** Constraints the palette was found with; optimising keeps them. */
  params: SearchParams
  optimising: boolean
  /** Score before the most recent optimisation. */
  prevScore?: number
}

const MAX_PARALLEL_OPTIMISERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1))

const parseHex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
]
const simulateHex = (h: string, v: Vision) => hex(linearToRgb(simulate(rgbToLinear(parseHex(h)), v)))
const lum = (h: string) => luminance(rgbToLinear(parseHex(h)))
const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '–')
const newWorker = () => new Worker(new URL('./lib/search.worker.ts', import.meta.url), { type: 'module' })

export default function App() {
  const [params, setParams] = useState<SearchParams>(paramsFromUrl)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<Entry[]>([])
  const [ran, setRan] = useState<SearchParams | null>(null)
  const searchRef = useRef<Worker | null>(null)
  const optimisers = useRef(new Set<Worker>())
  const queue = useRef<number[]>([])
  const resultsRef = useRef(results)
  const nextId = useRef(1)

  useEffect(() => {
    resultsRef.current = results
  }, [results])

  useEffect(() => paramsToUrl(params), [params])

  const lumWindow = luminanceWindow(params.minContrastBlack, params.minContrastWhite)
  const style = styleById(params.styleId)

  const set = <K extends keyof SearchParams>(key: K, value: SearchParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }))

  const stopSearch = () => {
    searchRef.current?.terminate()
    searchRef.current = null
  }
  const stopOptimisers = () => {
    optimisers.current.forEach((w) => w.terminate())
    optimisers.current.clear()
    queue.current = []
  }
  useEffect(
    () => () => {
      stopSearch()
      stopOptimisers()
    },
    [],
  )

  const start = () => {
    stopSearch()
    stopOptimisers()
    setResults([])
    setError(null)
    setStatus('running')
    setRan(params)
    const runParams = params
    const worker = newWorker()
    searchRef.current = worker
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data
      if (msg.type === 'found') {
        const entry: Entry = { id: nextId.current++, palette: msg.palette, params: runParams, optimising: false }
        setResults((r) => [...r, entry])
      } else if (msg.type === 'done') {
        setStatus(msg.reason === 'complete' ? 'done' : 'timeout')
        stopSearch()
      } else if (msg.type === 'error') {
        setError(msg.message)
        setStatus('error')
        stopSearch()
      }
    }
    worker.postMessage({ type: 'search', params } satisfies WorkerRequest)
  }

  const stop = () => {
    stopSearch()
    setStatus('stopped')
  }

  // Optimisation runs in a small pool of workers; extra requests wait in a queue.
  const pump = () => {
    while (optimisers.current.size < MAX_PARALLEL_OPTIMISERS && queue.current.length > 0) {
      const id = queue.current.shift()!
      const entry = resultsRef.current.find((r) => r.id === id)
      if (!entry) continue
      const worker = newWorker()
      optimisers.current.add(worker)
      const finish = (update: (e: Entry) => Entry) => {
        worker.terminate()
        optimisers.current.delete(worker)
        setResults((rs) => rs.map((r) => (r.id === id ? update(r) : r)))
        pump()
      }
      worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        const msg = e.data
        if (msg.type === 'optimised')
          finish((r) => ({ ...r, palette: msg.palette, prevScore: r.palette.metrics.score, optimising: false }))
        else if (msg.type === 'error') finish((r) => ({ ...r, optimising: false }))
      }
      worker.postMessage({ type: 'optimise', params: entry.params, palette: entry.palette } satisfies WorkerRequest)
    }
  }

  const optimise = (ids: number[]) => {
    const todo = ids.filter((id) => !queue.current.includes(id))
    const busy = new Set(resultsRef.current.filter((r) => r.optimising).map((r) => r.id))
    const fresh = todo.filter((id) => !busy.has(id))
    if (fresh.length === 0) return
    queue.current.push(...fresh)
    const marked = resultsRef.current.map((r) => (fresh.includes(r.id) ? { ...r, optimising: true } : r))
    resultsRef.current = marked
    setResults(marked)
    pump()
  }

  const sorted = useMemo(
    () => [...results].sort((a, b) => b.palette.metrics.score - a.palette.metrics.score),
    [results],
  )
  const running = status === 'running'
  const anyOptimising = results.some((r) => r.optimising)

  return (
    <div className="app">
      <header>
        <h1>Palette Search</h1>
        <p>
          Finds colour palettes where every pair is distinguishable (CIEDE2000) and every colour has enough
          WCAG contrast against both black and white.
        </p>
      </header>

      <main>
        <section className="panel controls">
          <h2>Constraints</h2>
          {NUMBER_FIELDS.map((f) => (
            <NumberField key={f.key} spec={f} value={params[f.key]} onChange={(v) => set(f.key, v)} />
          ))}

          <label className="check">
            <input type="checkbox" checked={params.colorBlind} onChange={(e) => set('colorBlind', e.target.checked)} />
            <span>
              Also comply for colour-blind people
              <small>ΔE must also hold under simulated protanopia, deuteranopia and tritanopia.</small>
            </span>
          </label>

          <label className="field">
            <span>Artistic choice</span>
            <select value={params.styleId} onChange={(e) => set('styleId', e.target.value)}>
              {STYLES.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <small>{style.description}</small>
          </label>

          <NumberField spec={TIME_FIELD} value={params.timeLimitSec} onChange={(v) => set('timeLimitSec', v)} />

          <div className={`hint ${lumWindow ? '' : 'bad'}`}>
            {lumWindow ? (
              <>
                Allowed relative luminance: <b>{fmt(lumWindow[0], 3)}</b> – <b>{fmt(lumWindow[1], 3)}</b>
                <LuminanceBar window={lumWindow} />
              </>
            ) : (
              <>No colour can meet both contrast values. The maximum of both together is about 4.58 : 1.</>
            )}
          </div>

          <div className="buttons">
            {running ? (
              <button className="stop" onClick={stop}>Stop</button>
            ) : (
              <button className="go" onClick={start} disabled={!lumWindow}>Search</button>
            )}
          </div>
        </section>

        <section className="results">
          <div className="results-head">
            <h2>
              Found palettes{' '}
              {ran && <span className="count">{results.length} / {ran.paletteCount}</span>}
            </h2>
            <StatusIndicator status={status} />
            {results.length > 1 && (
              <button className="small" onClick={() => optimise(sorted.map((r) => r.id))} disabled={anyOptimising}>
                Optimise all
              </button>
            )}
          </div>
          {error && <p className="error">{error}</p>}
          <p className="muted note">
            Sorted by score = (worst ΔE ÷ required ΔE) × (worst contrast ÷ required contrast). “Optimise” nudges
            colours to nearby values to raise the score while keeping every constraint.
          </p>
          {results.length === 0 && !running && <p className="muted">Nothing found yet. Press “Search”.</p>}
          <div className="grid">
            {sorted.map((entry, i) => (
              <PaletteCard key={entry.id} rank={i + 1} entry={entry} onOptimise={() => optimise([entry.id])} />
            ))}
          </div>
          {results.length > 0 && <ExportBox palettes={sorted.map((r) => r.palette)} />}
        </section>
      </main>
    </div>
  )
}

function NumberField({ spec, value, onChange }: { spec: NumberSpec; value: number; onChange: (v: number) => void }) {
  // Keep the raw text only while editing, so partial input like "4." isn't clobbered.
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className="field">
      <span>{spec.label}</span>
      <div className="num">
        <input
          type="number"
          value={draft ?? String(value)}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          onChange={(e) => {
            setDraft(e.target.value)
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(Math.min(spec.max, Math.max(spec.min, v)))
          }}
          onBlur={() => setDraft(null)}
        />
        {spec.suffix && <em>{spec.suffix}</em>}
      </div>
    </label>
  )
}

function LuminanceBar({ window }: { window: [number, number] }) {
  // Show the window on a perceptual (L*) scale so it is readable.
  const toPct = (Y: number) => (Y <= 0.008856 ? Y * 903.3 : 116 * Math.cbrt(Y) - 16)
  return (
    <div className="lumbar">
      <div className="lumbar-window" style={{ left: `${toPct(window[0])}%`, width: `${toPct(window[1]) - toPct(window[0])}%` }} />
    </div>
  )
}

function StatusIndicator({ status }: { status: Status }) {
  if (status === 'idle') return null
  const text: Record<Status, string> = {
    idle: '',
    running: 'Searching…',
    done: 'Done',
    timeout: 'Time limit reached',
    stopped: 'Stopped',
    error: 'Error',
  }
  return (
    <span className={`status ${status}`}>
      {status === 'running' && <span className="spinner" aria-hidden />}
      {text[status]}
    </span>
  )
}

function MetricsTable({ palette, params }: { palette: Palette; params: SearchParams }) {
  const m = palette.metrics
  const visions: Vision[] = ['normal', ...CVD_TYPES]
  return (
    <div className="metrics">
      {visions.map((v) => {
        const checked = v === 'normal' || params.colorBlind
        const val = m.minDeltaE[v]
        return (
          <div key={v} className={`metric ${checked ? '' : 'unchecked'}`}>
            <span>min ΔE {v === 'normal' ? '' : VISION_LABEL[v].toLowerCase()}</span>
            <b className={!checked ? '' : val >= params.minDeltaE ? 'pass' : 'fail'}>{fmt(val)}</b>
          </div>
        )
      })}
      <div className="metric">
        <span>min contrast vs black</span>
        <b className={m.minContrastBlack >= params.minContrastBlack ? 'pass' : 'fail'}>{fmt(m.minContrastBlack, 2)} : 1</b>
      </div>
      <div className="metric">
        <span>min contrast vs white</span>
        <b className={m.minContrastWhite >= params.minContrastWhite ? 'pass' : 'fail'}>{fmt(m.minContrastWhite, 2)} : 1</b>
      </div>
    </div>
  )
}

function PaletteCard({ rank, entry, onOptimise }: { rank: number; entry: Entry; onOptimise: () => void }) {
  const { palette, params, optimising, prevScore } = entry
  const [vision, setVision] = useState<Vision>('normal')
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text)
    setCopied(text)
    setTimeout(() => setCopied(null), 1000)
  }
  const shown = useMemo(() => palette.colors.map((c) => simulateHex(c, vision)), [palette, vision])
  const m = palette.metrics
  const gain = prevScore !== undefined ? m.score - prevScore : null

  return (
    <article className={`card ${optimising ? 'busy' : ''}`}>
      <div className="card-head">
        <h3>#{rank}</h3>
        <span className="score" title={`ΔE margin ${fmt(m.deltaEMargin, 2)} × contrast margin ${fmt(m.contrastMargin, 2)}`}>
          score <b>{fmt(m.score, 3)}</b>
          {gain !== null && <span className={gain > 0 ? 'pass' : 'muted'}> {gain > 0 ? `+${fmt(gain, 3)}` : '±0'}</span>}
        </span>
        <span className="spacer" />
        <select value={vision} onChange={(e) => setVision(e.target.value as Vision)} aria-label="Preview vision">
          {(['normal', ...CVD_TYPES] as Vision[]).map((v) => (
            <option key={v} value={v}>{VISION_LABEL[v]}</option>
          ))}
        </select>
        <button className="small" onClick={onOptimise} disabled={optimising}>
          {optimising ? (
            <>
              <span className="spinner" aria-hidden /> Optimising
            </>
          ) : (
            'Optimise'
          )}
        </button>
        <button className="small" onClick={() => copy(palette.colors.join(', '))}>
          {copied === palette.colors.join(', ') ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="swatches">
        {palette.colors.map((c, i) => {
          const Y = lum(c)
          return (
            <button key={c + i} className="swatch" style={{ background: shown[i] }} onClick={() => copy(c)} title="Copy hex">
              <span style={{ color: '#000' }}>Aa {fmt(contrastBlack(Y), 1)}</span>
              <span style={{ color: '#fff' }}>Aa {fmt(contrastWhite(Y), 1)}</span>
              <code>{copied === c ? 'copied' : c}</code>
            </button>
          )
        })}
      </div>
      {params.colorBlind && (
        <div className="cvd-rows">
          {CVD_TYPES.map((v) => (
            <div key={v} className="strip small" title={VISION_LABEL[v]}>
              {palette.colors.map((c, i) => (
                <div key={i} className="chip" style={{ background: simulateHex(c, v) }} />
              ))}
              <span className="strip-label">{VISION_LABEL[v]}</span>
            </div>
          ))}
        </div>
      )}
      <MetricsTable palette={palette} params={params} />
    </article>
  )
}

function ExportBox({ palettes }: { palettes: Palette[] }) {
  const [format, setFormat] = useState<'json' | 'css'>('json')
  const text =
    format === 'json'
      ? JSON.stringify(palettes.map((p) => p.colors), null, 2)
      : palettes
          .map((p, i) => `.palette-${i + 1} {\n${p.colors.map((c, j) => `  --color-${j + 1}: ${c};`).join('\n')}\n}`)
          .join('\n\n')
  return (
    <details className="export">
      <summary>Export all</summary>
      <div className="export-head">
        <select value={format} onChange={(e) => setFormat(e.target.value as 'json' | 'css')}>
          <option value="json">JSON</option>
          <option value="css">CSS custom properties</option>
        </select>
        <button className="small" onClick={() => navigator.clipboard?.writeText(text)}>Copy</button>
      </div>
      <pre>{text}</pre>
    </details>
  )
}
