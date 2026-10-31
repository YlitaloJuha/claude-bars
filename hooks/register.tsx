// One quiet line above the prompt: thin bars for the context window and plan limits,
// then the controls of the afk, wrap-up and todos mods, for those installed. Below it,
// each subagent and background task with its running time. The engine reports no
// percent-done for an agent, so its bar shows activity: it grows with tool calls and
// fills when the agent ends.
import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderSurface, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { BackgroundTask, Meter, Minibar } from '../types'

const CELLS = 8
const BAR_WIDTH = 56
const MINI_WIDTH = 28
const BAR_HEIGHT = 3
const TOOLS_FOR_FULL_BAR = 30
const MAX_RUNNING_FILL = 0.9
const MAX_ROWS = 4
const TICK_MS = 1000
const MAX_LABEL = 70
const COMPACT_FROM_PERCENT = 70
const RECONCILE_MS = 10_000
const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])
const AFK_MODES = ['off', 'develop', 'test', 'refactor', 'housekeeping'] as const
// Prompts no person sent, so they do not start a fresh list of agents.
const UNATTENDED = new Set(['plugin', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

const ICONS = {
  task: { text: '>_', svg: '<rect x="1" y="1" width="12" height="12" rx="3"/><path d="M4 5l2 2-2 2M7.5 9.5H10"/>' },
  agent: { text: '◈', svg: '<rect x="2" y="4" width="10" height="8" rx="2"/><path d="M7 1v3M5 8v.5M9 8v.5"/>' },
}

const COLORS = { track: '#8a8f9e40', quiet: '#8a8f9e', warning: '#d9a441', error: '#d9625b', done: '#7fb58a' }

const meters = atom({ plugin: 'bars', key: 'meters' } as const, [] as Meter[])
const agents = atom({ plugin: 'bars', key: 'agents' } as const, {} as Record<string, Minibar>)
const tasks = atom({ plugin: 'bars', key: 'tasks' } as const, {} as Record<string, BackgroundTask>)
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

export function metersOf(context: SessionContextUsage, limits: readonly SessionRateLimit[]): Meter[] {
  const rows = context.percent === undefined ? [] : [{ label: 'context', percent: context.percent }]
  return [...rows, ...limits.map(l => ({ label: LIMIT_LABELS[l.kind] ?? l.kind, percent: Math.round(l.percentUsed) }))]
}

export function miniFraction(agent: Minibar): number {
  return agent.status === 'running' ? Math.min(MAX_RUNNING_FILL, agent.tools / TOOLS_FOR_FULL_BAR) : 1
}

const meterColor = (percent: number) => (percent >= 90 ? COLORS.error : percent >= COMPACT_FROM_PERCENT ? COLORS.warning : COLORS.quiet)
const meterTheme = (percent: number) => (percent >= 90 ? 'error' : percent >= COMPACT_FROM_PERCENT ? 'warning' : undefined)
const miniColor = (agent: Minibar) => (agent.status === 'failed' ? COLORS.error : agent.status === 'done' ? COLORS.done : COLORS.quiet)

function drawBar(ui: ElementTable, surface: RenderSurface, fraction: number, width: number, cells: number, color: string, theme: 'error' | 'warning' | 'success' | undefined, alt: string) {
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

function drawIcon(ui: ElementTable, surface: RenderSurface, kind: keyof typeof ICONS) {
  const { Svg, Text } = ui as ElementTable & { Svg?: ElementTable['Text'] }
  if (surface === 'terminal' || Svg === undefined) return <Text dimColor>{ICONS[kind].text}</Text>
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" stroke="${COLORS.quiet}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind].svg}</svg>`
  return (Svg as never as (props: Record<string, unknown>) => ReturnType<ElementTable['Text']>)({ source, width: 14, height: 14, alt: kind === 'task' ? 'Background task' : 'Agent' })
}

// Redraws the running times while anything is running.
async function tick($: EngineInterface) {
  const running = Object.keys(await read($, tasks)).length > 0 || Object.values(await read($, agents)).some(a => a.status === 'running')
  if (running) {
    const now = await $.clock.now()
    await update($, clockNow, () => now)
  }
}

async function refreshMeters($: EngineInterface) {
  const usage = await $.session.usage()
  await update($, meters, () => metersOf(usage.context, usage.rateLimits))
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refreshMeters($)
    $.clock.every(RECONCILE_MS, () => reconcile($))
    $.clock.every(TICK_MS, () => tick($))
    // Also how the other mods tell that this line is here to hold their controls.
    await $.command.register({ name: 'bars', description: 'Show your context and plan limits', immediate: true })
    return result
  })

  on('command.run', { command: 'bars' }, async $ => {
    const rows = await read($, meters)
    return { text: rows.length > 0 ? rows.map(m => `${m.percent}% ${m.label}`).join('  ') : 'No readings yet.' }
  })

  on('session.measure', async ($, e, next) => {
    await update($, meters, () => metersOf(e.context, e.rateLimits))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, agents, () => ({}))
      await update($, tasks, () => ({}))
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
    const result = await next(e)
    const started = result.deny === undefined ? backgroundId(result.result) : undefined
    if (started !== undefined) {
      const input = e as { description?: unknown; command?: unknown }
      const label = String(input.description ?? input.command ?? e.tool).split('\n')[0]?.slice(0, MAX_LABEL) ?? e.tool
      const startedAt = await $.clock.now()
      await update($, tasks, current => ({ ...current, [started]: { label, startedAt } }))
    }
    if (e.tool === 'TaskStop') {
      const stopped = String((e as { task_id?: unknown; shell_id?: unknown }).task_id ?? (e as { shell_id?: unknown }).shell_id ?? '')
      await update($, tasks, current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== stopped)))
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
    }
    if (!UNATTENDED.has(e.origin.kind)) {
      await update($, agents, current =>
        Object.fromEntries(Object.entries(current).filter(([, agent]) => agent.status === 'running')),
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
    const agentRow = ([id, agent]: [string, Minibar]) => (
      <Box key={id} flexDirection="row" alignItems="center" gap={1}>
        {drawIcon(ui, e.surface, 'agent')}
        {drawBar(ui, e.surface, miniFraction(agent), MINI_WIDTH, CELLS / 2, miniColor(agent), agent.status === 'failed' ? 'error' : agent.status === 'done' ? 'success' : undefined, `${agent.label}: ${agent.status}`)}
        <Text dimColor wrap="truncate-end">{`${agent.label} · ${agent.status === 'running' ? `${agent.tools} tools` : agent.status} · ${elapsed((agent.endedAt ?? now) - agent.startedAt)}`}</Text>
      </Box>
    )
    const taskRow = ([id, task]: [string, BackgroundTask]) => (
      <Box key={id} flexDirection="row" alignItems="center" gap={1}>
        {drawIcon(ui, e.surface, 'task')}
        <Text dimColor wrap="truncate-end">{`${task.label} · ${elapsed(now - task.startedAt)}`}</Text>
      </Box>
    )
    // The newest stay in view; the rest open on hover, or stay hidden where no pointer reaches.
    const listed = <T,>(key: string, rows: Array<[string, T]>, draw: (row: [string, T]) => unknown) => {
      const hidden = rows.slice(0, -MAX_ROWS)
      return (
        <Box key={key} flexDirection="column">
          {hidden.length > 0 && <Text dimColor>{`+${hidden.length} more`}</Text>}
          {hidden.length > 0 && <Box flexDirection="column" display="none" hover={{ display: 'flex' }}>{hidden.map(draw) as never}</Box>}
          {rows.slice(-MAX_ROWS).map(draw) as never}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2}>
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
            {rows.map(m => (
              <Box key={m.label} flexDirection="row" alignItems="center" gap={1}>
                {drawBar(ui, e.surface, m.percent / 100, BAR_WIDTH, CELLS, meterColor(m.percent), meterTheme(m.percent), `${m.percent}% ${m.label}`)}
                <Text dimColor>{`${m.percent}% ${m.label}`}</Text>
              </Box>
            ))}
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={1}>
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
        {minis.length > 0 && listed('agents', minis, agentRow)}
        {running.length > 0 && listed('tasks', running, taskRow)}
        {rest}
      </Box>
    )
  })
}
