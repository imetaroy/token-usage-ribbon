import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheFacts, Fold, Window } from '../types'
import {
  TTL_MIN, TTL_MS, WORD,
  bandPx, cardSvg, costOf, familyOf, fmtIdle, kindOf, mineModel, usd,
} from './cache-art'
import type { CacheView } from './cache-art'

// One row above the prompt, drawn in Claude Code's own theme colours. Shows how
// much of each usage window is LEFT, 5-hour first, then 7-day; under 15% adds a
// red Low. After the first reply it also shows the prompt cache: Cache Warm for an
// hour after the last request, then Cache Cold with what the next message costs to
// re-cache. Show / Hide opens the cache card. The row never wraps: as the band
// narrows it trims extras, never the labels. Zero token cost: it reads the
// engine's own figures and draws.

const CELLS = 10
const LOW_AT = 15
const TIGHT_CELLS = 6
/** One even gap, in cells, between every group on the band. */
const GAP = 3
/** The Show / Hide button: its label plus the button's own padding. */
const BUTTON_CELLS = 8
/** How often the band redraws, so the countdown and the warm-to-cold flip stay current. */
const TICK_MS = 30_000

const windows = atom({ plugin: 'usage-ribbon', key: 'windows' } as const, [] as Window[])
const cache = atom({ plugin: 'usage-ribbon', key: 'cache' } as const, null as CacheFacts | null)
const fold = atom({ plugin: 'usage-ribbon', key: 'fold' } as const, null as Fold | null)

const NAMES: Record<string, string> = { seven_day: '7D', five_hour: '5H', spend_limit: 'SPEND' }
const ORDER: Record<string, number> = { five_hour: 0, seven_day: 1 }

const clean = (list: readonly Window[]): Window[] =>
  list
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
    .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9))

const dots = (left: number, cells: number): { on: string; off: string } => {
  const n = Math.max(0, Math.min(cells, Math.round((left / 100) * cells)))
  return { on: '●'.repeat(n), off: '·'.repeat(cells - n) }
}

const fmtReset = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resetting'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** What the cache drawings read, or null until a request and its context size are known. */
export const viewOf = (c: CacheFacts | null, now: number): CacheView | null => {
  if (!c || c.lastAt <= 0 || c.tokens <= 0) return null
  const idleMs = Math.max(0, now - c.lastAt)
  return {
    mode: idleMs >= TTL_MS ? 'cold' : 'warm',
    idle: fmtIdle(idleMs),
    idleMin: Math.floor(idleMs / 60000),
    tokens: c.tokens,
    window: c.window,
    mine: familyOf(c.model),
  }
}

const pull = async ($: EngineInterface): Promise<void> => {
  const u = await $.session.usage()
  await update($, windows, () => clean(u.rateLimits))
}

/** Fresh context figures from the engine onto the cache facts, when it has them. */
const measure = async ($: EngineInterface, lastAt: number | null, model: string | null): Promise<void> => {
  const u = await $.session.usage()
  const m = model ?? (await $.session.model())
  await update($, cache, c => ({
    lastAt: lastAt ?? c?.lastAt ?? 0,
    tokens: u.context.tokens && u.context.tokens > 0 ? u.context.tokens : (c?.tokens ?? 0),
    window: u.context.window || c?.window || 0,
    model: m || c?.model || null,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await pull($)
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, windows, () => clean(e.rateLimits))
    }
    if (e.changed.includes('context') && e.context.tokens && e.context.tokens > 0) {
      const tokens = e.context.tokens
      await update($, cache, c => (c ? { ...c, tokens, window: e.context.window || c.window } : c))
    }
    return next(e)
  })

  // A resumed or forked session knows how long it was away and how big it is.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear' || e.source === 'compact') {
      await update($, cache, () => null)
      await update($, fold, () => null)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const now = await $.clock.now()
      const lastAt = now - e.seconds_since_last_response * 1000
      const window = (await $.session.usage()).context.window
      const model = typeof e.model === 'string' ? e.model : await $.session.model()
      const tokens = typeof e.context_tokens === 'number' ? e.context_tokens : 0
      await update($, cache, () => ({ lastAt, tokens, window, model }))
    }
    return r
  }).catch(($, e, next) => next(e)) // a band that fails to seed never holds up the session

  // Each main-thread request reads or writes the cache, so its start resets the hour.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, cache, c => ({ lastAt: now, tokens: c?.tokens ?? 0, window: c?.window ?? 0, model: c?.model ?? null }))
    }
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    const c = await read($, cache)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    const lastAt = !c || now - c.lastAt > e.durationMs ? now : c.lastAt
    await measure($, lastAt, e.usage?.model ?? null)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // The cache card is a drawing; only surfaces that draw Svg get it and its button.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const list = clean(await read($, windows))
    const now = await $.clock.now()
    const view = viewOf(await read($, cache), now)

    // Claude Code's own theme keys, so the band follows the person's theme.
    const DIM = 'inactive'
    const OFF = 'subtle'
    const WIN: Record<string, string> = { seven_day: 'claude', five_hour: 'warning' }
    const CACHE: Record<string, string> = { warm: 'success', cold: 'suggestion' }

    if (list.length === 0 && !view) {
      return (
        <Box paddingX={1}>
          <Text color={DIM}>Usage · waiting for the first reply</Text>
        </Box>
      )
    }

    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100

    const mode = view?.mode ?? 'warm'
    const cold = mode === 'cold'
    const mine = view ? mineModel(view) : undefined
    const cost = view && mine ? usd(costOf(mine, mode, view.tokens)) : null
    const minsLeft = view ? Math.max(0, TTL_MIN - view.idleMin) : 0

    const stored = await read($, fold)
    // The card stays folded until asked for: a cold cache already shows its price on the row.
    const open = Svg !== null && view !== null && stored !== null && stored.mode === mode && stored.open
    const toggle = () => update($, fold, f => ({ mode, open: !(f && f.mode === mode && f.open) }))

    // One row, always. From the fullest form down, take the first that fits;
    // each step trims the least useful thing still showing.
    type Level = { cells: number; word: boolean; reset: boolean; label: boolean; long: boolean; button: boolean }
    const LEVELS: Level[] = [
      { cells: CELLS, word: true, reset: true, label: true, long: true, button: true },
      { cells: CELLS, word: true, reset: true, label: true, long: true, button: true },
      { cells: TIGHT_CELLS, word: true, reset: true, label: true, long: false, button: true },
      { cells: TIGHT_CELLS, word: false, reset: true, label: true, long: false, button: true },
      { cells: 0, word: false, reset: true, label: true, long: false, button: true },
      { cells: 0, word: false, reset: false, label: true, long: false, button: false },
    ]

    const parts = (w: Window, lv: Level) => {
      const left = Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10)
      const n = Math.max(0, Math.min(lv.cells, Math.round((left / 100) * lv.cells)))
      return {
        left,
        low: left < LOW_AT,
        col: WIN[w.kind] ?? 'text',
        name: NAMES[w.kind] ?? w.kind.toUpperCase(),
        on: '●'.repeat(n),
        off: '○'.repeat(lv.cells - n),
        pct: lv.word ? `${left}% left` : `${left}%`,
        reset: lv.reset ? fmtReset(w.resetsAt, now) : '',
      }
    }

    const cacheText = (lv: Level): { head: string; tail: string } => {
      if (!view) return { head: '', tail: '' }
      const head = `Cache ${cold ? "Cold" : "Warm"}`
      const tail = cold
        ? (lv.long ? ` ${view.idle} idle` : ` ${view.idle}`) + (cost ? ` · ${cost} next` : '')
        : lv.long ? ` ${minsLeft}m left` : ` ${minsLeft}m`
      return { head, tail }
    }

    const width = (lv: Level): number => {
      let w = 2 + (lv.label ? 'Usage'.length + GAP : 0)
      list.forEach((win, i) => {
        const p = parts(win, lv)
        w += p.name.length + 1 + (lv.cells ? lv.cells + 1 : 0) + p.pct.length +
          (p.low ? 4 : 0) + (p.reset ? ` · ${p.reset}`.length : 0) + (i > 0 ? GAP : 0)
      })
      if (view) {
        const c = cacheText(lv)
        w += GAP + 2 + c.head.length + c.tail.length
      }
      if (Svg && view && lv.button) w += 2 + BUTTON_CELLS
      return w
    }
    const lv = LEVELS.find(l => width(l) <= columns) ?? LEVELS[LEVELS.length - 1]!

    const win = (w: Window, i: number) => {
      const p = parts(w, lv)
      return (
        <Box key={`w-${i}`} flexDirection="row" flexShrink={0} marginLeft={i > 0 ? GAP : 0}>
          <Text color={DIM} bold>{p.name} </Text>
          {lv.cells ? <Text color={p.col}>{p.on}</Text> : null}
          {lv.cells ? <Text color={OFF}>{p.off} </Text> : null}
          <Text color={p.col} bold>{p.pct}</Text>
          {p.low ? <Text color="error" bold> Low</Text> : null}
          {p.reset ? <Text color={DIM}> · {p.reset}</Text> : null}
        </Box>
      )
    }

    const c = cacheText(lv)
    const cacheGroup = view ? (
      <Box key="cache" flexDirection="row" flexShrink={0} marginLeft={GAP}>
        <Text color={CACHE[mode]}>● </Text>
        <Text color={CACHE[mode]} bold>{c.head}</Text>
        <Text color={DIM}>{c.tail}</Text>
      </Box>
    ) : null

    const button = Svg && view && lv.button ? (
      <Box key="fold" flexShrink={0} marginLeft={2}>
        <Button key="cache-fold" label={open ? 'Hide' : 'Show'} onPress={toggle} dimColor />
      </Box>
    ) : null

    const row = (
      <Box key="row" flexDirection="row" paddingX={1} alignItems="center">
        {lv.label ? <Box key="label" flexShrink={0} marginRight={GAP}><Text color={DIM} bold>Usage</Text></Box> : null}
        {list.map(win)}
        <Box key="grow" flexGrow={1} />
        {cacheGroup}
        {button}
      </Box>
    )

    let card = null
    if (open && Svg && view) {
      const k = cardSvg(view, kindOf(columns), bandPx(columns))
      card = (
        <Box key="card" flexDirection="row">
          <Svg source={k.source} alt={k.alt} width={k.w} height={k.h} isInteractive={kindOf(columns) !== 'tight'} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {row}
        {card}
      </Box>
    )
  })
}
