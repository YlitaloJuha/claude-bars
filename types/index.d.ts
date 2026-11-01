export type Meter = { label: string; percent: number; tokens?: number }

export type Minibar = {
  label: string
  tools: number
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
}

export type BackgroundTask = {
  label: string
  startedAt: number
}

export type TestRun = {
  label: string
  status: 'running' | 'passed' | 'failed' | 'stopped' | 'ended'
  startedAt: number
  endedAt?: number
  isBackground?: boolean
  hidesExit?: boolean
  isScanned?: boolean
}

declare module 'claude-code' {
  // What the mods that share this line add to `$`; a call throws when one is not installed.
  interface EngineInterface {
    afk: { choose: (args: { mode: 'off' | 'develop' | 'test' | 'refactor' | 'housekeeping' }) => Promise<void> }
    wrapUp: { start: (args: Record<string, never>) => Promise<void> }
    todos: { toggle: (args: Record<string, never>) => Promise<void> }
  }

  interface PluginState {
    bars: {
      meters: Meter[]
      agents: Record<string, Minibar>
      tasks: Record<string, BackgroundTask>
      tests: Record<string, TestRun>
      clockNow: number
      isCompacting: boolean
      isAfkMenuOpen: boolean
    }
  }
}
