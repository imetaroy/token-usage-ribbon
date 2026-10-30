import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const WINDOWS = [
  { kind: 'five_hour', percentUsed: 18, resetsAt: '2099-01-01T01:29:00Z' },
  { kind: 'seven_day', percentUsed: 1 },
]
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as const
const WARM_IDLE = 18 * 60 // 18 minutes: warm, cold in 42m
const COLD_IDLE = (3 * 24 + 9) * 3600 // 3d 9h: cold

const SESSION = 's-1'
const IDLE_2H = 2 * 3600 // cold, and well inside the 7 days the band keeps saved facts

const seed = async ($: any, on: any, idle: number) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: SESSION }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: idle, context_tokens: 770000, model: 'claude-opus-5-5' })
}

test('a warm cache shows as text on the row, with the minutes left, folded', async ($, on) => {
  await seed($, on, WARM_IDLE)
  const band = await $.ui.mount({ plugin: 'token-usage-ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  // The row is plain text in theme colours: no drawings until the card opens.
  expect(await band.findAll({ type: 'Svg' })).toEqual([])
  expect(await band.find({ text: 'Cache Warm' })).toBeDefined()
  expect(await band.find({ text: ' 42m left' })).toBeDefined()
  expect(await band.find({ key: 'card' })).toBeUndefined()
  expect((await band.find({ key: 'cache-fold' }))?.props.label).toBe('Show')

  await band.press({ key: 'cache-fold' })
  expect(await band.find({ key: 'card' })).toBeDefined()
  expect((await band.find({ key: 'cache-fold' }))?.props.label).toBe('Hide')
  await band.unmount()
})

test('a cold cache shows its re-cache price on the row and opens the card on Show', async ($, on) => {
  await seed($, on, COLD_IDLE)
  const band = await $.ui.mount({ plugin: 'token-usage-ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ key: 'card' })).toBeUndefined()
  expect(await band.find({ text: 'Cache Cold' })).toBeDefined()
  // Opus 5.5: 770k tokens at the 1-hour write price, 2 x $4 per million.
  expect(await band.find({ text: ' 3d 9h idle · $6.16 next' })).toBeDefined()

  await band.press({ key: 'cache-fold' })
  const card = await band.find({ key: 'card' })
  expect(JSON.stringify(card)).toContain('Cache cold. Idle 3d 9h. Next message re-caches 770k tokens.')
  // 120 columns is a 1500 px band.
  expect(JSON.stringify(card)).toContain('width=\\"1500\\"')
  await band.unmount()
})

test('squeezed, the cache never leaves the row: the band trims extras, keeping every label', async ($, on) => {
  await seed($, on, WARM_IDLE)
  for (const bodyColumns of [120, 80, 53, 33]) {
    const band = await $.ui.mount({ plugin: 'token-usage-ribbon', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns } })
    const rows = await band.findAll({ key: 'row' })
    expect(rows.length).toBe(1)
    expect(JSON.stringify(rows[0])).toContain('Cache Warm')
    expect(await band.find({ text: 'Usage' })).toBeDefined()
    expect(await band.find({ key: 'block' })).toBeUndefined()
    const all = JSON.stringify(rows[0])
    expect(all.indexOf('5H')).toBeLessThan(all.indexOf('7D'))
    await band.unmount()
  }
})

test('the terminal draws the cache as text, with no drawings and no fold button', async ($, on) => {
  await seed($, on, COLD_IDLE)
  const band = await $.ui.mount({ plugin: 'token-usage-ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'Cache Cold' })).toBeDefined()
  expect(await band.find({ text: ' 3d 9h idle · $6.16 next' })).toBeDefined()
  expect(await band.findAll({ type: 'Svg' })).toEqual([])
  expect(await band.find({ key: 'cache-fold' })).toBeUndefined()
  expect(await band.find({ key: 'card' })).toBeUndefined()
  await band.unmount()
})

test('a cleared session drops the cache until the next reply', async ($, on) => {
  await seed($, on, COLD_IDLE)
  await $.classic.SessionStart({ source: 'clear' })
  const band = await $.ui.mount({ plugin: 'token-usage-ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'Cache Cold' })).toBeUndefined()
  expect(await band.find({ text: '99% left' })).toBeDefined()
  await band.unmount()
})

test('a restarted process brings the cache back from what the session saved', async ($, on) => {
  // The process restarted: $.state is empty, but the store still holds this session's facts.
  mock.store(on, { [`cache:${SESSION}`]: { lastAt: NOW - IDLE_2H * 1000, tokens: 770000, window: 1000000, model: 'claude-opus-5-5' } })
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: SESSION }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const band = await $.ui.mount({ plugin: 'token-usage-ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'Cache Cold' })).toBeDefined()
  expect(await band.find({ text: ' 2h 0m idle · $6.16 next' })).toBeDefined()
  await band.unmount()
})

test('saved facts from a session idle over 7 days are dropped, not shown', async ($, on) => {
  mock.store(on, { [`cache:${SESSION}`]: { lastAt: NOW - 8 * 24 * 3600 * 1000, tokens: 770000, window: 1000000, model: 'claude-opus-5-5' } })
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: SESSION }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const band = await $.ui.mount({ plugin: 'token-usage-ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'Cache Cold' })).toBeUndefined()
  await band.unmount()
})

test('a resume with no token count still shows the cache state, without a price or card', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: SESSION }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: IDLE_2H, model: 'claude-opus-5-5' })

  const band = await $.ui.mount({ plugin: 'token-usage-ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'Cache Cold' })).toBeDefined()
  expect(await band.find({ text: ' 2h 0m idle' })).toBeDefined()
  expect(await band.find({ key: 'cache-fold' })).toBeUndefined()
  await band.unmount()
})
