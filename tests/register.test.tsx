import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionStartInput, TurnCompleteInput } from 'claude-code'

import { metersOf, miniFraction, svgBar, textBar } from '../hooks/register'

const session: SessionStartInput = { surface: 'desktop', isInteractive: true, cwd: '/work' }
const props: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 75, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const LIMITS = [{ kind: 'five_hour', percentUsed: 23.5 }, { kind: 'seven_day', percentUsed: 91 }]
const mount = { plugin: 'bars', surface: 'desktop', component: 'AbovePrompt', props } as const

type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', ...over })
const spawn = (description: string) => ({ tool_use_id: 'u' + description, prompt: 'go', description })

function world(on: On, opts: { list?: Array<{ id: string; status: string }>; percent?: number; siblings?: boolean; turnCount?: number } = {}) {
  const compacted: string[] = []
  const chosen: string[] = []
  const wrapped: number[] = []
  const toggled: number[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.turns', () => ({ value: opts.turnCount ?? 3 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000, tokens: 680, percent: opts.percent ?? 42 }, rateLimits: LIMITS } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'A1' }))
  on('agent.list', () => ({ value: (opts.list ?? []) as never }))
  on('command.list', () => ({ value: (opts.siblings ? ['afk', 'wrap-up', 'todos'] : []).map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('command.run', ($, e) => { compacted.push(e.command); return { text: '' } })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['beneath'] }))
  if (opts.siblings) {
    on('engine.create', async ($, e, next) => ({ ...(await next(e)), afk: { choose: async () => undefined }, wrapUp: { start: async () => undefined }, todos: { toggle: async () => undefined } }))
    on('afk.choose' as never, (($: unknown, e: { mode: string }) => { chosen.push(e.mode); return { value: undefined } }) as never)
    on('wrapUp.start' as never, (() => { wrapped.push(1); return { value: undefined } }) as never)
    on('todos.toggle' as never, (() => { toggled.push(1); return { value: undefined } }) as never)
  }
  return { compacted, chosen, wrapped, toggled }
}

test('text bars are thin lines of a fixed width', () => {
  expect(textBar(0, 4)).toEqual({ filled: '', empty: '────' })
  expect(textBar(0.5, 4)).toEqual({ filled: '━━', empty: '──' })
  expect(textBar(1.5, 4)).toEqual({ filled: '━━━━', empty: '' })
  expect(textBar(-1, 4)).toEqual({ filled: '', empty: '────' })
})

test('drawn bars have a track and a fill only when there is something to fill', () => {
  expect(svgBar(0, 56, '#fff').match(/<rect/g)?.length).toBe(1)
  expect(svgBar(0.5, 56, '#fff')).toContain('width="28"')
  expect(svgBar(0.5, 56, '#fff')).toContain('fill="#fff"')
})

test('meters name the context and each limit', () => {
  expect(metersOf({ window: 1000, percent: 68 }, LIMITS)).toEqual([
    { label: 'context', percent: 68 },
    { label: '5h', percent: 24 },
    { label: '7d', percent: 91 },
  ])
  expect(metersOf({ window: 1000 }, [])).toEqual([])
})

test('a running minibar never reads as finished', () => {
  expect(miniFraction({ label: 'a', tools: 300, status: 'running' })).toBe(0.9)
  expect(miniFraction({ label: 'a', tools: 3, status: 'done' })).toBe(1)
})

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`the line draws on ${surface}`, async ($, on) => {
    mock.clock(on)
    world(on, { siblings: true })
    await $.session.start({ ...session, surface })
    const ui = await $.ui.mount({ ...mount, surface })
    expect(await ui.find({ type: 'Text', text: /42% context/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /24% 5h/ })).toBeDefined()
    expect(await ui.find({ key: 'afk' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /beneath/ })).toBeDefined()
  })
}

test('the desktop draws its bars, the terminal writes them', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const desk = await $.ui.mount(mount)
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.unmount()
  const term = await $.ui.mount({ ...mount, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /─/ })).toBeDefined()
})

test('without the other mods there are no controls for them', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  for (const key of ['afk', 'wrap-up', 'todos']) expect(await ui.find({ key })).toBeUndefined()
})

test('Compact waits until the context is worth compacting, and runs /compact', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { percent: 75 })
  await $.session.start(session)
  const busy = await $.ui.mount({ ...mount, props: { ...props, isWorking: true } })
  expect(await busy.find({ key: 'compact' })).toBeUndefined()
  await busy.unmount()
  const ui = await $.ui.mount(mount)
  await ui.press({ key: 'compact' })
  await clock.advance(5)
  expect(w.compacted).toEqual(['compact'])
})

test('Compact stays out of the way at low context', async ($, on) => {
  mock.clock(on)
  world(on, { percent: 42 })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
})

test('AFK opens a menu, and a mode goes to the afk mod', async ($, on) => {
  mock.clock(on)
  const w = world(on, { siblings: true })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  expect(await ui.find({ key: 'afk-test' })).toBeUndefined()
  await ui.press({ key: 'afk' })
  await ui.press({ key: 'afk-test' })
  expect(w.chosen).toEqual(['test'])
  expect(await ui.find({ key: 'afk-test' })).toBeUndefined()
})

test('Wrap up goes to the wrap-up mod, and waits for a first turn', async ($, on) => {
  mock.clock(on)
  const w = world(on, { siblings: true })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await ui.press({ key: 'wrap-up' })
  expect(w.wrapped).toEqual([1])
})

test('no Wrap up before the first turn', async ($, on) => {
  mock.clock(on)
  world(on, { siblings: true, turnCount: 0 })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  expect(await ui.find({ key: 'wrap-up' })).toBeUndefined()
})

test('the todos control stays while only ticked items are left', async ($, on) => {
  mock.clock(on)
  const w = world(on, { siblings: true })
  on('state.get', ($, e) => ({ value: { value: e.plugin === 'todos' && e.key === 'visible' ? [{ id: 'a' }] : e.plugin === 'todos' && e.key === 'open' ? [] : undefined, version: 1 } }) as never)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  expect((await ui.find({ key: 'todos' }))?.props.label).toBe('todos ✓')
  await ui.press({ key: 'todos' })
  expect(w.toggled).toEqual([1])
})

test('an agent gets a thin bar that counts its tools and ends done', async ($, on) => {
  mock.clock(on)
  world(on, { list: [{ id: 'A1', status: 'running' }] })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.agent.spawn(spawn('Read the API'))
  await $.tool.call({ tool: 'Read', file_path: 'a', agentId: 'A1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'b', agentId: 'A1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'c' } as never)
  expect((await ui.find({ type: 'Text', text: /Read the API/ }))?.text).toBe('Read the API · 2 tools')
  await $.turn.complete(turn({ agentId: 'A1' } as never))
  expect((await ui.find({ type: 'Text', text: /Read the API/ }))?.text).toBe('Read the API · done')
})

test('an agent stopped with no turn end is settled from the engine list', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { list: [{ id: 'A1', status: 'killed' }] })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.agent.spawn(spawn('Stopped one'))
  await clock.advance(10_000)
  expect((await ui.find({ type: 'Text', text: /Stopped one/ }))?.text).toContain('failed')
})

test('the next message from the person clears finished agents only', async ($, on) => {
  mock.clock(on)
  world(on, { list: [{ id: 'A1', status: 'completed' }] })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.agent.spawn(spawn('Old work'))
  await $.turn.complete(turn({ agentId: 'A1' } as never))
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ type: 'Text', text: /Old work/ })).toBeUndefined()
})
