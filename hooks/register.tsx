// One quiet line above the prompt: thin bars for the context window and plan limits,
// then the controls of the afk, wrap-up and todos mods, for those installed. Below it,
// a thin bar per subagent. The engine reports no percent-done for an agent, so its bar
// shows activity: it grows with tool calls and fills when the agent ends.
import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderSurface, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Meter, Minibar } from '../types'

const CELLS = 8
const BAR_WIDTH = 56
const MINI_WIDTH = 28
const BAR_HEIGHT = 3
const TOOLS_FOR_FULL_BAR = 30
const MAX_RUNNING_FILL = 0.9
const MAX_AGENT_ROWS = 6
const COMPACT_FROM_PERCENT = 70
const RECONCILE_MS = 10_000
const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])
const AFK_MODES = ['off', 'develop', 'test', 'refactor', 'housekeeping'] as const
// Prompts no person sent, so they do not start a fresh list of agents.
const UNATTENDED = new Set(['plugin', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

const COLORS = { track: '#8a8f9e40', quiet: '#8a8f9e', warning: '#d9a441', error: '#d9625b', done: '#7fb58a' }

const meters = atom({ plugin: 'bars', key: 'meters' } as const, [] as Meter[])
const agents = atom({ plugin: 'bars', key: 'agents' } as const, {} as Record<string, Minibar>)
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

async function refreshMeters($: EngineInterface) {
  const usage = await $.session.usage()
  await update($, meters, () => metersOf(usage.context, usage.rateLimits))
}

// An agent that was stopped raises no turn.complete: the engine's list is the truth.
async function reconcile($: EngineInterface) {
  const known = await read($, agents)
  if (!Object.values(known).some(a => a.status === 'running')) return
  const live = await $.agent.list()
  await update($, agents, current => {
    const next = { ...current }
    for (const [id, agent] of Object.entries(current)) {
      if (agent.status !== 'running') continue
      const info = live.find(a => a.id === id)
      if (info === undefined || info.status === 'completed') next[id] = { ...agent, status: 'done' }
      else if (!LIVE.has(info.status)) next[id] = { ...agent, status: 'failed' }
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
    if (e.reason === 'clear' || e.reason === 'resume') await update($, agents, () => ({}))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = result.agentId
    if (id !== undefined) {
      await update($, agents, current => ({ ...current, [id]: { label: e.description, tools: 0, status: 'running' } }))
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
    return next(e)
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
    await update($, agents, current => {
      const agent = current[id]
      return agent === undefined ? current : { ...current, [id]: { ...agent, status } }
    })
    return result
  })

  // A new message from the person clears the agents that have finished.
  on('prompt.submit', async ($, e, next) => {
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
    const shown = minis.slice(-MAX_AGENT_ROWS)
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
        {minis.length > shown.length && <Text dimColor>{`+${minis.length - shown.length} earlier agents`}</Text>}
        {shown.map(([id, agent]) => (
          <Box key={id} flexDirection="row" alignItems="center" gap={1}>
            {drawBar(ui, e.surface, miniFraction(agent), MINI_WIDTH, CELLS / 2, miniColor(agent), agent.status === 'failed' ? 'error' : agent.status === 'done' ? 'success' : undefined, `${agent.label}: ${agent.status}`)}
            <Text dimColor wrap="truncate-end">{`${agent.label} · ${agent.status === 'running' ? `${agent.tools} tools` : agent.status}`}</Text>
          </Box>
        ))}
        {rest}
      </Box>
    )
  })
}
