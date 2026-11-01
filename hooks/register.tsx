// One quiet line above the prompt: thin bars for the context window and plan limits,
// then the controls of the afk, wrap-up and todos mods, for those installed. With it,
// each subagent, test run and background task with its running time. The engine reports
// no percent-done for an agent, so its bar shows activity: it grows with tool calls and
// fills when the agent ends. A test run is known by its command, from its tool call or,
// outside this session, from `ps`. It shows no count: the engine hands a mod a command's
// output only once it has ended.
import { atom, read, update } from 'claude-code'
import type { Color, ElementTable, EngineInterface, Register, RenderSurface, SessionContextBreakdown, SessionContextUsage, SessionRateLimit, ToolCallResult } from 'claude-code'

import type { BackgroundTask, ContextBreakdown, Meter, Minibar, TestRun } from '../types'

const CELLS = 8
const BAR_WIDTH = 56
const MINI_WIDTH = 28
const BAR_HEIGHT = 3
// A fluid bar's thickness and its zone line's, in rows of text, with the step between them.
const FLUID_BAR_ROWS = 0.2
const ZONE_ROWS = 0.1
const ZONE_GAP = 0.2
const PART_GAP = 0.2
// How much more of the line the context bar takes than a limit bar.
const CONTEXT_WEIGHT = 3
// How often a run of responses may ask for the breakdown again.
const BREAKDOWN_MS = 30_000
const TOOLS_FOR_FULL_BAR = 30
const MAX_RUNNING_FILL = 0.9
const MAX_ROWS = 4
// The band's rows the meters and the other mods' rows take before the lists get theirs.
const LINE_ROWS = 3
// A card taller than the window scrolls, and each redraw takes it back to its top.
const MAX_CARD_ROWS = 20
const TICK_MS = 1000
const MAX_LABEL = 70
const COMPACT_FROM_PERCENT = 70
// Past roughly this many tokens the model decides worse, whatever the window's size.
const SMART_ZONE_TOKENS = 100_000
// From these shares of its window the context meter's label turns yellow, then red.
const YELLOW_LABEL_PERCENT = 30
const RED_LABEL_PERCENT = 60
const RECONCILE_MS = 10_000
const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])
const AFK_MODES = ['off', 'develop', 'test', 'refactor', 'housekeeping'] as const
// Prompts no person sent, so they do not start a fresh list of agents.
const UNATTENDED = new Set(['plugin', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

const TEST_RUNNERS = /^(?:pytest|py\.test|tox|nox|unittest|nose2|jest|vitest|mocha|ava|karma|cypress|rspec|phpunit|pest|ctest|nextest|gotestsum|behave|bats)$/
// `test`, `test:unit`, `unit-test`, and `t` for `npm t`.
const TEST_TARGETS = /^(?:t|(?:[\w.-]+[:_-])?(?:tests?|specs?)(?:[:_-][\w.:-]+)?)$/
// `./test`, `bin/test`, `run-tests.sh`, `test_api.py`, `tests/smoke.py`.
const TEST_SCRIPTS = /(?:^|[-_./])tests?(?:[-_./]\S*)?$/
// Tools with a test target of their own, and the ones that run what their arguments name.
const TEST_TOOLS = String.raw`npm|yarn|pnpm|bun|deno|manage\.py|cargo|go|swift|xcodebuild|mvn|mvnw|gradle|gradlew|dotnet|make|just|task|rake|rails|mix|flutter|dart|nx|turbo|zig|sbt|lein|composer|bazel|playwright`
const TEST_HOSTS = new RegExp(String.raw`^(?:${TEST_TOOLS}|npx|bunx|pnpx|uvx|uv|poetry|pipenv|pdm|hatch|rye|bundle|python\d*(?:\.\d+)*|node|ruby|php|perl|bash|sh|zsh|tsx|ts-node|claude|docker|podman|env|time|timeout|nice|sudo|command|exec)$`)
// A process has lost its quotes, so a process takes this narrower reading.
const PROCESS_TOOLS = new RegExp(`^(?:${TEST_TOOLS})$`)
const INTERPRETERS = /^(?:node|python\d*(?:\.\d+)*|ruby|php|perl)$/i
const WATCHING = /\s--watch(?:All)?\b/
const PS_ARGV = ['ps', '-Aww', '-o', 'pid=', '-o', 'ppid=', '-o', 'etime=', '-o', 'command=']
const SCAN_MS = 10_000
// What such a tool does when it only installs or lists a test tool.
const TEST_INSTALLS = /^(?:add|install|i|ci|remove|rm|uninstall|update|upgrade|audit|why|ls|list|info|view|outdated|link|publish|init|new|create|pull|push|get|mod|doc|fmt|vet|pip|venv|stop|start|logs|kill)$/
const NOT_A_RUN = /\s--(?:version|help|dry-run|collect-only)\b/
const LEADING_SHELL = /^(?:(?:[({]|(?:do|then|else)\s|\w+=\S*\s)\s*)+/
const SAYS_FAILED = /\b[1-9]\d*\s+(?:tests?\s+)?(?:failed|failing|fail|failures?|errors?)\b|^FAIL(?:ED)?\b|^not ok\b/m
const SAYS_PASSED = /\b[1-9]\d*\s+(?:tests?\s+)?(?:passed|passing|pass)\b|^ok\b/im

const ICONS = {
  task: { text: '>_', alt: 'Background task', svg: '<rect x="1" y="1" width="12" height="12" rx="3"/><path d="M4 5l2 2-2 2M7.5 9.5H10"/>' },
  agent: { text: '◈', alt: 'Agent', svg: '<rect x="2" y="4" width="10" height="8" rx="2"/><path d="M7 1v3M5 8v.5M9 8v.5"/>' },
  test: { text: '◎', alt: 'Test run', svg: '<path d="M5.5 1.5h3M6 1.5v4.2L2.9 11a1 1 0 0 0 .9 1.5h6.4a1 1 0 0 0 .9-1.5L8 5.7V1.5M4.4 9h5.2"/>' },
}

const COLORS = { track: '#8a8f9e40', quiet: '#8a8f9e', warning: '#d9a441', error: '#d9625b', done: '#7fb58a', smart: '#7fb58a', pastSmart: '#e8703a', other: '#9c9c9c', reserved: '#5f5f5f' }
// The largest rows of the context bar, as the desktop's context panel colours them.
const PART_COLORS = ['#4a8fe7', '#dd7a3c', '#4fae8c']

type Proc = { pid: number; ppid: number; elapsedMs: number; command: string }
type BarPart = { name: string; tokens: number; color: string }

const meters = atom({ plugin: 'bars', key: 'meters' } as const, [] as Meter[])
const breakdown = atom({ plugin: 'bars', key: 'breakdown' } as const, null as ContextBreakdown | null)
const agents = atom({ plugin: 'bars', key: 'agents' } as const, {} as Record<string, Minibar>)
const tasks = atom({ plugin: 'bars', key: 'tasks' } as const, {} as Record<string, BackgroundTask>)
const tests = atom({ plugin: 'bars', key: 'tests' } as const, {} as Record<string, TestRun>)
const clockNow = atom({ plugin: 'bars', key: 'clockNow' } as const, 0)
const isCompacting = atom({ plugin: 'bars', key: 'isCompacting' } as const, false)
const isAfkMenuOpen = atom({ plugin: 'bars', key: 'isAfkMenuOpen' } as const, false)

// What the other mods keep, read here so one line can show it all.
const afkMode = atom({ plugin: 'afk', key: 'mode' } as const, 'off')
const afkTaken = atom({ plugin: 'afk', key: 'taken' } as const, 0)
const wrapUpPhase = atom({ plugin: 'wrap-up', key: 'phase' } as const, 'idle')
const openTodos = atom({ plugin: 'todos', key: 'open' } as const, [] as unknown[])
const visibleTodos = atom({ plugin: 'todos', key: 'visible' } as const, [] as unknown[])

/** A thin bar as text, for the terminal. */
export function textBar(fraction: number, cells: number): { filled: string; empty: string } {
  const count = Math.max(0, Math.min(cells, Math.round(fraction * cells)))
  return { filled: '━'.repeat(count), empty: '─'.repeat(cells - count) }
}

/** A thin rounded bar as a drawing, for the surfaces that take one. */
export function svgBar(fraction: number, width: number, color: string): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  const fill = filled === 0 ? '' : `<rect width="${Math.max(filled, BAR_HEIGHT)}" height="${BAR_HEIGHT}" rx="1.5" fill="${color}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAR_HEIGHT}"><rect width="${width}" height="${BAR_HEIGHT}" rx="1.5" fill="${COLORS.track}"/>${fill}</svg>`
}

/** Running time as `45s`, `2m 04s` or `1h 03m`. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m`
}

/** The ids a background task notification reports on. */
export function notifiedIds(text: string): string[] {
  return [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(m => m[1] ?? '')
}

/** The background task a tool call left running, or undefined. */
export function backgroundId(result: unknown): string | undefined {
  const record = (result ?? {}) as { backgroundTaskId?: unknown; taskId?: unknown }
  const id = record.backgroundTaskId ?? record.taskId
  return typeof id === 'string' && id !== '' ? id : undefined
}

const baseName = (word: string) => (word.split('/').pop() ?? '').replace(/\.[cm]?js$/, '')

// Quotes are blanked, so a commit message or a search pattern never reads as a command.
const unquoted = (command: string) => command.replace(/"[^"]*"|'[^']*'/g, '""')

/** Whether a shell command runs tests: a runner by name, a tool's test target or a test script. */
export function isTestCommand(command: string): boolean {
  const plain = unquoted(command)
  if (NOT_A_RUN.test(plain)) return false
  return plain.split(/[;|&\n)}]/).some(part => {
    const [first = '', ...rest] = part.trim().replace(LEADING_SHELL, '').split(/\s+/)
    const tool = first.split('/').pop() ?? ''
    if (TEST_RUNNERS.test(tool)) return true
    // A bare `test` is the shell's own condition.
    if (!TEST_HOSTS.test(tool)) return first !== 'test' && TEST_SCRIPTS.test(first)
    const args = rest.filter(word => word === '--test' || !/^[-\d]/.test(word))
    if (TEST_INSTALLS.test(args[0] ?? '')) return false
    return TEST_SCRIPTS.test(args[0] ?? '') || args.some(word => word === '--test' || TEST_TARGETS.test(word) || TEST_RUNNERS.test(baseName(word)))
  })
}

/** The words a process runs, without the interpreter: `node /x/.bin/jest -i` is `/x/.bin/jest -i`. */
function processWords(command: string): string[] {
  const [first = '', ...rest] = command.trim().split(/\s+/)
  return INTERPRETERS.test(baseName(first)) ? rest : [first, ...rest]
}

/** Whether a running process is a test run. Stays narrow: it reads every process on the machine. */
export function isTestProcess(command: string): boolean {
  if (WATCHING.test(command) || NOT_A_RUN.test(command)) return false
  const words = processWords(command).filter(word => !word.startsWith('-'))
  const [tool = '', next = '', after = ''] = words.map(baseName)
  if (TEST_RUNNERS.test(tool)) return true
  if (tool === 'claude') return next === 'plugin' && after === 'test'
  if (!PROCESS_TOOLS.test(tool) || TEST_INSTALLS.test(next)) return false
  const target = /^(?:run|exec|x)$/.test(next) ? after : next
  return TEST_TARGETS.test(target) || TEST_RUNNERS.test(target) || TEST_TARGETS.test(words.at(-1) ?? '')
}

/** A process's command as a row shows it: `pytest -q`, with no paths or interpreter. */
export function processLabel(command: string): string {
  const words = command.trim().split(/\s+/)
  // `python3 -m pytest` keeps its interpreter, or it would read as `-m pytest`.
  const shown = INTERPRETERS.test(baseName(words[0] ?? '')) && !(words[1] ?? '-').startsWith('-') ? words.slice(1) : words
  return [baseName(shown[0] ?? ''), ...shown.slice(1)].join(' ').slice(0, MAX_LABEL)
}

/** Time from `ps` as milliseconds: `[[dd-]hh:]mm:ss`. */
export function etimeMs(text: string): number {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text]
  return (Number(days) * 86_400 + (clock ?? '').split(':').reduce((sum, part) => sum * 60 + Number(part), 0)) * 1000
}

export function parseProcesses(stdout: string): Proc[] {
  return stdout.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    return m === null ? [] : [{ pid: Number(m[1]), ppid: Number(m[2]), elapsedMs: etimeMs(m[3] ?? ''), command: m[4] ?? '' }]
  })
}

/**
 * The test runs no tool call has a row for. While one has, what runs beneath the engine is
 * left to it; otherwise a script Claude ran may hide a runner. `npm test` over `jest` is
 * one run, so it is the topmost that counts.
 */
export function untrackedTestRuns(processes: readonly Proc[], enginePid: number, isTracking: boolean): Proc[] {
  const byPid = new Map(processes.map(p => [p.pid, p]))
  const ancestors = (p: Proc) => {
    const chain: Proc[] = []
    for (let up = byPid.get(p.ppid); up !== undefined && chain.length < 64; up = byPid.get(up.ppid)) chain.push(up)
    return chain
  }
  return processes.filter(p => isTestProcess(p.command) && !ancestors(p).some(up => (isTracking && up.pid === enginePid) || isTestProcess(up.command)))
}

/** Whether a pipe or a `;` keeps the runner's exit code from being the command's. */
export const hidesExit = (command: string) => /[|;\n]/.test(unquoted(command))

/** How a command that ran in the foreground ended. With its exit code hidden, its output decides. */
export function testVerdict(exitHidden: boolean | undefined, isError: boolean, text: string): TestRun['status'] {
  if (isError) return /^Exit code \d/.test(text) ? 'failed' : 'stopped'
  if (!exitHidden) return 'passed'
  if (SAYS_FAILED.test(text)) return 'failed'
  return SAYS_PASSED.test(text) ? 'passed' : 'ended'
}

/** How a background command ended, from its notification's status. */
export function backgroundVerdict(exitHidden: boolean | undefined, status: string | undefined): TestRun['status'] {
  if (status === 'failed') return 'failed'
  if (status === 'killed') return 'stopped'
  return status === 'completed' && !exitHidden ? 'passed' : 'ended'
}

/** The status a notification gives for each task it reports on. */
export function notifiedStatuses(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/<task-id>([^<]+)<\/task-id>(?:(?!<task-id>)[\s\S])*?<status>([^<]+)<\/status>/g)].map(m => [m[1] ?? '', m[2] ?? '']))
}

/** What the bar needs of the engine's breakdown: tool schemas loaded on demand are outside the window. */
export function breakdownOf(from: SessionContextBreakdown): ContextBreakdown {
  return { scale: from.rawMaxTokens, rows: from.categories.flatMap(c => (c.kind === 'deferred' ? [] : [{ name: c.name, tokens: c.tokens, kind: c.kind }])) }
}

const usedIn = (known: ContextBreakdown) => known.rows.reduce((sum, row) => sum + (row.kind === 'used' ? row.tokens : 0), 0)

/** The context meter reads against the window compaction runs at, once known, as the context panel does. */
export function metersOf(context: SessionContextUsage, limits: readonly SessionRateLimit[], known?: ContextBreakdown | null): Meter[] {
  const rows = []
  if (context.percent !== undefined) {
    const tokens = context.tokens ?? Math.round((context.window * context.percent) / 100)
    const hasScale = known != null && known.scale > 0
    const percent = hasScale ? Math.round((Math.max(tokens, usedIn(known)) * 100) / known.scale) : context.percent
    rows.push({ label: 'context', percent, tokens, scale: hasScale ? known.scale : context.window })
  }
  return [...rows, ...limits.map(l => ({ label: LIMIT_LABELS[l.kind] ?? l.kind, percent: Math.round(l.percentUsed) }))]
}

/**
 * The context bar's parts and its legend, grouped as the context panel groups them: the
 * largest rows in colour and the rest as one, then what came since the breakdown was
 * counted, which the live figure shows and the breakdown does not yet.
 */
export function contextParts(known: ContextBreakdown, tokens: number): { filled: BarPart[]; reserved?: BarPart; legend: BarPart[] } {
  const used = known.rows.filter(row => row.kind === 'used').sort((a, b) => b.tokens - a.tokens)
  const since = Math.max(0, tokens - usedIn(known))
  const colored = used.map((row, i) => ({ name: row.name, tokens: row.tokens, color: PART_COLORS[i] ?? COLORS.other }))
  const rest = colored.slice(PART_COLORS.length)
  const sinceRows = since > 0 ? [{ name: 'Since last update', tokens: since, color: COLORS.other }] : []
  const buffer = known.rows.find(row => row.kind === 'buffer')
  const reserved = buffer === undefined ? undefined : { name: buffer.name, tokens: buffer.tokens, color: COLORS.reserved }
  const free = known.rows.find(row => row.kind === 'free')
  return {
    filled: [...colored.slice(0, PART_COLORS.length), ...(rest.length > 0 ? [{ name: 'Other', tokens: rest.reduce((sum, row) => sum + row.tokens, 0), color: COLORS.other }] : []), ...sinceRows],
    reserved,
    legend: [...colored, ...sinceRows, ...(reserved === undefined ? [] : [reserved]), ...(free === undefined ? [] : [{ name: free.name, tokens: Math.max(0, free.tokens - since), color: COLORS.track }])],
  }
}

/** Tokens as the context panel writes them: `775`, `18.1k`, `196k`. */
export function tokenText(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

export function miniFraction(agent: Minibar): number {
  return agent.status === 'running' ? Math.min(MAX_RUNNING_FILL, agent.tools / TOOLS_FOR_FULL_BAR) : 1
}

/** How many of each list's newest rows fit `room` rows, a list's count line included. */
export function rowsInView(lengths: readonly number[], room: number): number {
  const rowsAt = (inView: number) => lengths.reduce((sum, n) => sum + Math.min(n, inView) + (n > inView ? 1 : 0), 0)
  let inView = MAX_ROWS
  while (inView > 1 && rowsAt(inView) > room) inView--
  return inView
}

// A card is narrow and cuts a long row, so there what the row came to goes first.
const rowText = (label: string, tail: string, inCard: boolean) => (inCard ? `${tail} · ${label}` : `${label} · ${tail}`)

// Only the context meter has tokens: it shows the zone the model does its best work in.
export const meterColor = (m: Meter) =>
  m.percent >= 90 ? COLORS.error
  : m.tokens !== undefined ? (m.tokens < SMART_ZONE_TOKENS ? COLORS.smart : COLORS.pastSmart)
  : m.percent >= COMPACT_FROM_PERCENT ? COLORS.warning
  : COLORS.quiet
const meterTheme = (m: Meter): Color | undefined =>
  m.percent >= 90 ? 'error'
  : m.tokens !== undefined ? (m.tokens < SMART_ZONE_TOKENS ? 'success' : COLORS.pastSmart)
  : m.percent >= COMPACT_FROM_PERCENT ? 'warning'
  : undefined
const miniColor = (agent: Minibar) => (agent.status === 'failed' ? COLORS.error : agent.status === 'done' ? COLORS.done : COLORS.quiet)

function drawBar(ui: ElementTable, surface: RenderSurface, fraction: number, width: number, cells: number, color: string, theme: Color | undefined, alt: string) {
  if (surface === 'terminal') {
    const { filled, empty } = textBar(fraction, cells)
    return (
      <ui.Text>
        <ui.Text color={theme} dimColor={theme === undefined}>{filled}</ui.Text>
        <ui.Text dimColor>{empty}</ui.Text>
      </ui.Text>
    )
  }
  const { Svg } = ui as { Svg?: ElementTable['Text'] }
  const source = svgBar(fraction, width, color)
  return Svg === undefined ? null : (Svg as never as (props: Record<string, unknown>) => ReturnType<ElementTable['Text']>)({ source, width, height: BAR_HEIGHT, alt })
}

// Boxes rather than a drawing, since a drawing has a width of its own and a Box fills its row.
function drawFluidBar(ui: ElementTable, total: number, filled: readonly BarPart[], reserved?: BarPart, zone?: { tokens: number; color: string }) {
  const { Box } = ui
  const shown = filled.filter(p => p.tokens > 0)
  const free = Math.max(0, total - shown.reduce((sum, p) => sum + p.tokens, 0) - (reserved?.tokens ?? 0))
  // A share of the bar, since the engine holds a grow to at most 10000.
  const grow = (tokens: number) => Math.min(10_000, Math.round((tokens * 10_000) / Math.max(total, 1)))
  const part = (p: BarPart) => <Box flexGrow={grow(p.tokens)} backgroundColor={p.color} />
  return (
    <Box flexDirection="column" flexGrow={1} minWidth={0} rowGap={ZONE_GAP}>
      <Box flexDirection="row" height={FLUID_BAR_ROWS} columnGap={PART_GAP} backgroundColor={COLORS.track} overflow="hidden">
        {shown.map(part) as never}
        {free > 0 && <Box flexGrow={grow(free)} />}
        {reserved !== undefined && part(reserved)}
      </Box>
      {/* Every bar keeps this row, so that a limit bar stays level with the context bar. */}
      <Box flexDirection="row" height={ZONE_ROWS}>
        {zone !== undefined && <Box flexGrow={grow(zone.tokens)} backgroundColor={zone.color} />}
        {zone !== undefined && zone.tokens < total && <Box flexGrow={grow(total - zone.tokens)} />}
      </Box>
    </Box>
  )
}

function drawLegend(ui: ElementTable, meter: Meter, scale: number, legend: readonly BarPart[]) {
  const { Box, Text } = ui
  const line = (key: string, color: string, name: string, value: string) => (
    <Box key={key} flexDirection="row" justifyContent="space-between" columnGap={3}>
      <Box flexDirection="row" columnGap={1}>
        <Text color={color}>■</Text>
        <Text>{name}</Text>
      </Box>
      <Text dimColor>{value}</Text>
    </Box>
  )
  // At the bar's right end: the pointer on a card is on its bar, so a card over the counts at
  // the left would keep itself open and hide them from a pointer coming up from the prompt.
  return (
    <Box flexDirection="column" position="absolute" right={0} display="none" hover={{ display: 'flex' }}>
      <Text>{`${meter.percent}% used · ${tokenText(meter.tokens ?? 0)} / ${tokenText(scale)}`}</Text>
      {legend.map(p => line(p.name, p.color, p.name, `${tokenText(p.tokens)} · ${((p.tokens * 100) / Math.max(scale, 1)).toFixed(1)}%`)) as never}
      {line('zone', COLORS.smart, 'Best range', `up to ${tokenText(SMART_ZONE_TOKENS)}`)}
    </Box>
  )
}

function drawIcon(ui: ElementTable, surface: RenderSurface, kind: keyof typeof ICONS) {
  const { Svg, Text } = ui as ElementTable & { Svg?: ElementTable['Text'] }
  if (surface === 'terminal' || Svg === undefined) return <Text dimColor>{ICONS[kind].text}</Text>
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" stroke="${COLORS.quiet}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind].svg}</svg>`
  return (Svg as never as (props: Record<string, unknown>) => ReturnType<ElementTable['Text']>)({ source, width: 14, height: 14, alt: ICONS[kind].alt })
}

// Redraws the running times while anything is running.
async function tick($: EngineInterface) {
  const running = Object.keys(await read($, tasks)).length > 0 || Object.values(await read($, agents)).some(a => a.status === 'running') || Object.values(await read($, tests)).some(t => t.status === 'running')
  if (running) {
    const now = await $.clock.now()
    await update($, clockNow, () => now)
  }
}

// `summary` is counted locally, so a breakdown sends no request.
async function refreshMeters($: EngineInterface) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const fresh = usage.context.breakdown
  if (fresh !== undefined) await update($, breakdown, () => breakdownOf(fresh))
  const known = await read($, breakdown)
  await update($, meters, () => metersOf(usage.context, usage.rateLimits, known))
}

// An agent that was stopped raises no turn.complete: the engine's list is the truth.
async function reconcile($: EngineInterface) {
  const known = await read($, agents)
  if (!Object.values(known).some(a => a.status === 'running')) return
  const live = await $.agent.list()
  const now = await $.clock.now()
  await update($, agents, current => {
    const next = { ...current }
    for (const [id, agent] of Object.entries(current)) {
      if (agent.status !== 'running') continue
      const info = live.find(a => a.id === id)
      if (info === undefined || info.status === 'completed') next[id] = { ...agent, status: 'done', endedAt: now }
      else if (!LIVE.has(info.status)) next[id] = { ...agent, status: 'failed', endedAt: now }
    }
    return next
  })
}

function compact($: EngineInterface) {
  void update($, isCompacting, () => true)
  // Work a press starts ends with the press; a timer gives /compact its own dispatch.
  $.clock.after(1, () =>
    $.command
      .run({ command: 'compact' })
      .catch((error: unknown) => $.ui.toast(`Compacting failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => update($, isCompacting, () => false)),
  )
}

async function chooseAfk($: EngineInterface, mode: (typeof AFK_MODES)[number]) {
  await update($, isAfkMenuOpen, () => false)
  await $.afk.choose({ mode })
}

// No hook sees a run outside this session, so `ps` is the only sign of it. Its exit code
// never reaches here, so such a run can only end as `ended`.
async function scanProcesses($: EngineInterface, enginePid: number) {
  const { exitCode, stdout } = await $.process.run(PS_ARGV)
  if (exitCode !== 0) return
  const known = await read($, tests)
  const isTracking = Object.values(known).some(run => run.isScanned !== true && run.status === 'running')
  const seen = new Map(untrackedTestRuns(parseProcesses(stdout), enginePid, isTracking).map(p => [`pid:${p.pid}`, p]))
  const isGone = (id: string, run: TestRun) => run.isScanned === true && run.status === 'running' && !seen.has(id)
  const isChanged = Object.entries(known).some(([id, run]) => isGone(id, run)) || [...seen.keys()].some(id => known[id]?.status !== 'running')
  if (!isChanged) return
  const now = await $.clock.now()
  await update($, tests, current => {
    const next = { ...current }
    for (const [id, run] of Object.entries(current)) if (isGone(id, run)) next[id] = { ...run, status: 'ended', endedAt: now }
    for (const [id, p] of seen) {
      if (current[id]?.status !== 'running') next[id] = { label: processLabel(p.command), status: 'running', startedAt: now - p.elapsedMs, isScanned: true }
    }
    return next
  })
}

// The parent of what the engine starts is the engine, and all it runs sits beneath that.
async function startScan($: EngineInterface) {
  const { stdout } = await $.process.run(['sh', '-c', 'echo $PPID'])
  const enginePid = Number(stdout.trim())
  const timer = $.clock.every(SCAN_MS, () => {
    scanProcesses($, enginePid).catch(() => timer.cancel())
  })
}

const labelOf = (e: { tool: string }) => {
  const input = e as { description?: unknown; command?: unknown }
  return String(input.description ?? input.command ?? e.tool).split('\n')[0]?.slice(0, MAX_LABEL) ?? e.tool
}

async function endTest($: EngineInterface, id: string, status: TestRun['status']) {
  const endedAt = await $.clock.now()
  await update($, tests, current => {
    const run = current[id]
    return run === undefined ? current : { ...current, [id]: { ...run, status, endedAt } }
  })
}

// A refused call drops its row; one that went to the background goes on under its task's id.
async function settleTest($: EngineInterface, id: string, result: ToolCallResult, taskId: string | undefined) {
  const endedAt = await $.clock.now()
  await update($, tests, current => {
    const { [id]: run, ...rest } = current
    if (run === undefined) return current
    if (result.deny !== undefined) return rest
    if (taskId !== undefined) return { ...rest, [taskId]: { ...run, isBackground: true } }
    return { ...current, [id]: { ...run, status: testVerdict(run.hidesExit, result.isError === true, result.text ?? ''), endedAt } }
  })
}

export const register: Register = on => {
  let breakdownAt = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refreshMeters($)
    $.clock.every(RECONCILE_MS, () => reconcile($))
    $.clock.every(TICK_MS, () => tick($))
    // Where there is no `sh` or `ps`, there is no scan.
    await startScan($).catch(() => undefined)
    // Also how the other mods tell that this line is here to hold their controls.
    await $.command.register({ name: 'bars', description: 'Show your context and plan limits', immediate: true })
    return result
  })

  on('command.run', { command: 'bars' }, async $ => {
    const rows = await read($, meters)
    return { text: rows.length > 0 ? rows.map(m => `${m.percent}% ${m.label}`).join('  ') : 'No readings yet.' }
  })

  on('session.measure', async ($, e, next) => {
    const known = await read($, breakdown)
    await update($, meters, () => metersOf(e.context, e.rateLimits, known))
    const now = await $.clock.now()
    if (now - breakdownAt >= BREAKDOWN_MS) {
      breakdownAt = now
      await refreshMeters($).catch(() => undefined)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, breakdown, () => null)
      await update($, agents, () => ({}))
      await update($, tasks, () => ({}))
      await update($, tests, () => ({}))
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = result.agentId
    if (id !== undefined) {
      const startedAt = await $.clock.now()
      await update($, agents, current => ({ ...current, [id]: { label: e.description, tools: 0, status: 'running', startedAt } }))
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      await update($, agents, current => {
        const agent = current[id]
        return agent === undefined ? current : { ...current, [id]: { ...agent, tools: agent.tools + 1 } }
      })
    }
    const testCommand = e.tool === 'Bash' && isTestCommand(e.command) ? e.command : undefined
    if (testCommand !== undefined) {
      const startedAt = await $.clock.now()
      await update($, tests, current => ({ ...current, [e.tool_use_id]: { label: labelOf(e), status: 'running', startedAt, hidesExit: hidesExit(testCommand) } }))
    }
    const result = await next(e).catch(async (error: unknown) => {
      await endTest($, e.tool_use_id, 'stopped')
      throw error
    })
    const started = result.deny === undefined ? backgroundId(result.result) : undefined
    if (testCommand !== undefined) {
      await settleTest($, e.tool_use_id, result, started)
    } else if (started !== undefined) {
      const startedAt = await $.clock.now()
      await update($, tasks, current => ({ ...current, [started]: { label: labelOf(e), startedAt } }))
    }
    if (e.tool === 'TaskStop') {
      const stopped = String((e as { task_id?: unknown; shell_id?: unknown }).task_id ?? (e as { shell_id?: unknown }).shell_id ?? '')
      await update($, tasks, current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== stopped)))
      await endTest($, stopped, 'stopped')
    }
    return result
  })

  // What is still running when Claude stops: anything else has ended unannounced.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const running = e.background_tasks
    if (Array.isArray(running)) {
      const ids = new Set(running.map(t => t.id))
      await update($, tasks, current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))))
      const endedAt = await $.clock.now()
      await update($, tests, current =>
        Object.fromEntries(Object.entries(current).map(([id, run]) => [id, run.isBackground && run.status === 'running' && !ids.has(id) ? { ...run, status: 'ended' as const, endedAt } : run])),
      )
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const id = e.agentId
    if (id === undefined) {
      await refreshMeters($)
      await reconcile($)
      return result
    }
    const status = e.isAborted || e.reason === 'error' || e.reason === 'refusal' ? 'failed' : 'done'
    const endedAt = await $.clock.now()
    await update($, agents, current => {
      const agent = current[id]
      return agent === undefined ? current : { ...current, [id]: { ...agent, status, endedAt } }
    })
    return result
  })

  // A new message from the person clears the agents that have finished.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const ended = new Set(notifiedIds(e.text))
      await update($, tasks, current => Object.fromEntries(Object.entries(current).filter(([id]) => !ended.has(id))))
      const statuses = notifiedStatuses(e.text)
      const now = await $.clock.now()
      // A notification can come after Stop has already settled the run, and it knows better.
      await update($, tests, current =>
        Object.fromEntries(Object.entries(current).map(([id, run]) => [id, ended.has(id) ? { ...run, status: backgroundVerdict(run.hidesExit, statuses[id]), endedAt: run.endedAt ?? now } : run])),
      )
    }
    if (!UNATTENDED.has(e.origin.kind)) {
      await update($, agents, current =>
        Object.fromEntries(Object.entries(current).filter(([, agent]) => agent.status === 'running')),
      )
      await update($, tests, current =>
        Object.fromEntries(Object.entries(current).filter(([, run]) => run.status === 'running')),
      )
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    const rows = await read($, meters)
    const minis = Object.entries(await read($, agents))
    const context = rows.find(m => m.label === 'context')?.percent ?? 0
    const canCompact = context >= COMPACT_FROM_PERCENT && !e.props.isWorking && !(await read($, isCompacting))
    // A mod's noun cannot be tested for, so its command says whether it is installed.
    const installed = new Set((await $.command.list()).map(c => c.name))
    const mode = installed.has('afk') ? await read($, afkMode) : null
    const taken = await read($, afkTaken)
    const isMenuOpen = mode !== null && (await read($, isAfkMenuOpen))
    const phase = installed.has('wrap-up') ? await read($, wrapUpPhase) : null
    const hasTurns = e.props.isWorking || (await $.session.turns()) > 0
    const todoCount = installed.has('todos') ? (await read($, openTodos)).length : 0
    // Ticked items wait for their archive button, so the list still has to open.
    const hasTodoList = installed.has('todos') && (await read($, visibleTodos)).length > 0
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const now = Math.max(await read($, clockNow), await $.clock.now())
    const running = Object.entries(await read($, tasks))
    const testRuns = Object.entries(await read($, tests))
    const agentRow = ([id, agent]: [string, Minibar], inCard: boolean) => (
      <Box key={id} flexDirection="row" alignItems="center" gap={1}>
        {drawIcon(ui, e.surface, 'agent')}
        {drawBar(ui, e.surface, miniFraction(agent), MINI_WIDTH, CELLS / 2, miniColor(agent), agent.status === 'failed' ? 'error' : agent.status === 'done' ? 'success' : undefined, `${agent.label}: ${agent.status}`)}
        <Text dimColor wrap="truncate-end">{rowText(agent.label, `${agent.status === 'running' ? `${agent.tools} ${agent.tools === 1 ? 'tool' : 'tools'}` : agent.status} · ${elapsed((agent.endedAt ?? now) - agent.startedAt)}`, inCard)}</Text>
      </Box>
    )
    const testRow = ([id, run]: [string, TestRun], inCard: boolean) => (
      <Box key={id} flexDirection="row" alignItems="center" gap={1}>
        {drawIcon(ui, e.surface, 'test')}
        <Text color={run.status === 'failed' ? 'error' : undefined} dimColor={run.status !== 'failed'} wrap="truncate-end">{rowText(run.label, `${run.status === 'running' ? '' : `${run.status} · `}${elapsed((run.endedAt ?? now) - run.startedAt)}`, inCard)}</Text>
      </Box>
    )
    const taskRow = ([id, task]: [string, BackgroundTask], inCard: boolean) => (
      <Box key={id} flexDirection="row" alignItems="center" gap={1}>
        {drawIcon(ui, e.surface, 'task')}
        <Text dimColor wrap="truncate-end">{rowText(task.label, elapsed(now - task.startedAt), inCard)}</Text>
      </Box>
    )
    const inView = rowsInView([minis.length, testRuns.length, running.length], Math.min(e.props.maxRows, e.props.scroll.bodyRows) - LINE_ROWS - (isMenuOpen ? 1 : 0))
    // The terminal draws bars in fixed cells and clips a card to the band, so its bars keep
    // their width and its older rows open in place.
    const isGraphical = e.surface !== 'terminal'
    const known = await read($, breakdown)
    const meterRow = (m: Meter) => {
      const labelColor = m.tokens === undefined ? undefined : m.percent >= RED_LABEL_PERCENT ? 'error' : m.percent >= YELLOW_LABEL_PERCENT ? 'warning' : undefined
      const text = <Text color={labelColor} dimColor={labelColor === undefined} wrap={isGraphical ? 'truncate-end' : undefined}>{`${m.percent}% ${m.label}`}</Text>
      if (!isGraphical) {
        return (
          <Box key={m.label} flexDirection="row" alignItems="center" gap={1}>
            {drawBar(ui, e.surface, m.percent / 100, BAR_WIDTH, CELLS, meterColor(m), meterTheme(m), `${m.percent}% ${m.label}`)}
            {text}
          </Box>
        )
      }
      if (m.tokens === undefined) {
        return (
          <Box key={m.label} flexDirection="row" alignItems="center" gap={1} flexGrow={1} minWidth={0}>
            {drawFluidBar(ui, 100, [{ name: m.label, tokens: m.percent, color: meterColor(m) }])}
            {text}
          </Box>
        )
      }
      const scale = m.scale ?? 1
      const parts = known === null ? undefined : contextParts(known, m.tokens)
      return (
        <Box key={m.label} flexDirection="row" alignItems="center" gap={1} flexGrow={CONTEXT_WEIGHT} minWidth={0}>
          {drawFluidBar(ui, scale, parts?.filled ?? [{ name: m.label, tokens: m.tokens, color: meterColor(m) }], parts?.reserved, { tokens: SMART_ZONE_TOKENS, color: COLORS.smart })}
          {text}
          {parts !== undefined && drawLegend(ui, m, scale, parts.legend)}
        </Box>
      )
    }
    // The newest stay in view, next to the prompt. The rest open on hover over the count, as
    // a card above it that moves nothing: rows opening inside the band fight its scrolling.
    // Where no pointer reaches, they stay hidden.
    const listed = <T,>(key: string, rows: Array<[string, T]>, draw: (row: [string, T], inCard: boolean) => unknown) => {
      const hidden = rows.slice(0, -inView)
      const opened = hidden.slice(-MAX_CARD_ROWS)
      return (
        <Box key={key} flexDirection="column">
          {hidden.length > 0 && (
            <Box key={`${key}-more`} flexDirection="column">
              <Text dimColor>{`+${hidden.length} more`}</Text>
              <Box flexDirection="column" position={isGraphical ? 'absolute' : undefined} display="none" hover={{ display: 'flex' }}>
                {hidden.length > opened.length && <Text dimColor>{`+${hidden.length - opened.length} older`}</Text>}
                {opened.map(row => draw(row, isGraphical)) as never}
              </Box>
            </Box>
          )}
          {rows.slice(-inView).map(row => draw(row, false)) as never}
        </Box>
      )
    }
    const lists = (
      <Box flexDirection="column">
        {minis.length > 0 && listed('agents', minis, agentRow)}
        {testRuns.length > 0 && listed('tests', testRuns, testRow)}
        {running.length > 0 && listed('tasks', running, taskRow)}
      </Box>
    )
    // A card opens upward, so the lists stand above the meters and it covers no meter. The
    // terminal's rows open in place, and there the meters keep the top.
    return (
      <Box flexDirection="column">
        {isGraphical && lists}
        <Box flexDirection="row" flexWrap={isGraphical ? 'nowrap' : 'wrap'} justifyContent="space-between" alignItems="center" columnGap={2}>
          <Box flexDirection="row" flexWrap={isGraphical ? 'nowrap' : 'wrap'} flexGrow={isGraphical ? 1 : 0} minWidth={0} alignItems="center" columnGap={2}>
            {rows.map(meterRow) as never}
          </Box>
          <Box flexDirection="row" flexShrink={0} alignItems="center" columnGap={1}>
            {canCompact && <Button key="compact" label="Compact" plain dimColor onPress={() => compact($)} />}
            {hasTodoList && <Button key="todos" label={todoCount === 0 ? 'todos ✓' : todoCount === 1 ? '1 todo' : `${todoCount} todos`} plain dimColor onPress={() => $.todos.toggle({})} />}
            {mode !== null && (
              <Button key="afk" label={mode === 'off' ? 'AFK' : `AFK ${mode} ${taken}`} plain dimColor={mode === 'off' ? true : undefined} onPress={() => update($, isAfkMenuOpen, open => !open)} />
            )}
            {phase === 'idle' && hasTurns && <Button key="wrap-up" label="Wrap up" plain dimColor onPress={() => $.wrapUp.start({})} />}
            {phase !== null && phase !== 'idle' && <Text dimColor>Wrapping up</Text>}
          </Box>
        </Box>
        {isMenuOpen && (
          <Box flexDirection="row" justifyContent="flex-end" columnGap={1}>
            {AFK_MODES.map(m => (
              <Button key={`afk-${m}`} label={m} plain dimColor={m === mode ? undefined : true} onPress={() => chooseAfk($, m)} />
            ))}
          </Box>
        )}
        {!isGraphical && lists}
        {rest}
      </Box>
    )
  })
}
