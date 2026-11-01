import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionStartInput, TurnCompleteInput } from 'claude-code'

import { backgroundId, backgroundVerdict, elapsed, etimeMs, hidesExit, isTestCommand, isTestProcess, meterColor, metersOf, miniFraction, notifiedIds, notifiedStatuses, parseProcesses, processLabel, svgBar, testVerdict, textBar, untrackedTestRuns } from '../hooks/register'

const session: SessionStartInput = { surface: 'desktop', isInteractive: true, cwd: '/work' }
const props: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 75, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const LIMITS = [{ kind: 'five_hour', percentUsed: 23.5 }, { kind: 'seven_day', percentUsed: 91 }]
const mount = { plugin: 'bars', surface: 'desktop', component: 'AbovePrompt', props } as const

type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', ...over })
const spawn = (description: string) => ({ tool_use_id: 'u' + description, prompt: 'go', description })

const ENGINE = 900

function world(on: On, opts: { list?: Array<{ id: string; status: string }>; percent?: number; tokens?: number; siblings?: boolean; turnCount?: number; hold?: Promise<unknown>; ps?: () => string } = {}) {
  const compacted: string[] = []
  if (opts.ps !== undefined) {
    const ps = opts.ps
    on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'sh' ? `${ENGINE}\n` : ps(), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  }
  const chosen: string[] = []
  const wrapped: number[] = []
  const toggled: number[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.turns', () => ({ value: opts.turnCount ?? 3 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000, tokens: opts.tokens ?? 680, percent: opts.percent ?? 42 }, rateLimits: LIMITS } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', async ($, e) => {
    await opts.hold
    return ((e as { fakeAnswer?: object }).fakeAnswer ?? { result: (e as { fakeResult?: object }).fakeResult ?? {} }) as never
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'A1' }))
  on('agent.list', () => ({ value: (opts.list ?? []) as never }))
  on('command.list', () => ({ value: (opts.siblings ? ['afk', 'wrap-up', 'todos'] : []).map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
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
    { label: 'context', percent: 68, tokens: 680 },
    { label: '5h', percent: 24 },
    { label: '7d', percent: 91 },
  ])
  expect(metersOf({ window: 1_000_000, tokens: 123_456, percent: 12 }, [])[0]?.tokens).toBe(123_456)
  expect(metersOf({ window: 1000 }, [])).toEqual([])
})

test('the context bar is green in the smart zone and orange-red past 100k tokens', () => {
  const context = (tokens: number, percent: number) => meterColor({ label: 'context', percent, tokens })
  expect(context(99_999, 10)).toBe('#7fb58a')
  expect(context(100_000, 10)).toBe('#e8703a')
  expect(context(100_000, 50)).toBe('#e8703a')
  expect(context(180_000, 90)).toBe('#d9625b')
})

test('the limit bars stay quiet until 70%', () => {
  expect(meterColor({ label: '5h', percent: 69 })).toBe('#8a8f9e')
  expect(meterColor({ label: '5h', percent: 70 })).toBe('#d9a441')
  expect(meterColor({ label: '7d', percent: 90 })).toBe('#d9625b')
})

test('the terminal paints the context bar by its zone', async ($, on) => {
  mock.clock(on)
  world(on, { tokens: 150_000, percent: 15 })
  await $.session.start({ ...session, surface: 'terminal' })
  const ui = await $.ui.mount({ ...mount, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^━+$/ }))?.props.color).toBe('#e8703a')
})

for (const command of [
  'pytest', 'pytest -q tests/api', '.venv/bin/pytest', 'python .venv/bin/pytest -q', 'node node_modules/.bin/jest', 'python -m pytest', 'python3.12 -m unittest discover', 'uv run pytest', 'poetry run pytest -x',
  'npm test', 'npm t', 'npm run test', 'npm run test:unit', 'yarn test', 'yarn jest', 'pnpm --filter web test', 'pnpm exec vitest run', 'bun test', 'npx --yes jest', 'node --test',
  'cargo test', 'cargo nextest run', 'go test ./...', 'swift test', 'xcodebuild -scheme App test', 'mvn test', './gradlew test', 'dotnet test', 'make test', 'make -C api test-unit', 'just test',
  'bundle exec rspec', 'rails test', 'python manage.py test', 'mix test', 'claude plugin test .', 'playwright test', 'docker compose exec web pytest',
  './run-tests.sh', 'bin/test', 'bash scripts/test.sh', 'python tests/smoke.py', 'python test_api.py',
  'cd api && pytest', 'CI=1 npm test', 'timeout 60 pytest', 'time go test ./...', 'npm run build && npm test', 'pytest 2>&1 | tail -20', '(cd api; pytest)', 'for f in a b; do pytest $f; done',
]) {
  test(`reads a test run: ${command}`, () => expect(isTestCommand(command)).toBe(true))
}

for (const command of [
  'ls test', 'cat tests/a.py', 'git add tests/', 'git diff test', 'grep -r pytest .', 'rg "go test" src', 'mkdir tests', 'echo pytest', 'test -f a.txt', '[ -f test ]',
  'pip install pytest', 'npm install jest', 'yarn add -D vitest', 'uv pip install pytest', 'python -m pip install pytest', 'uv add pytest',
  'git commit -m "run pytest && go test"', 'pytest --version', 'jest --help', 'npm run build', 'cargo build --tests', 'go build ./test', 'sh build.sh', 'python build.py', 'node server.js', 'claude plugin validate .', 'npx playwright install',
]) {
  test(`does not read a test run: ${command}`, () => expect(isTestCommand(command)).toBe(false))
}

for (const command of [
  'pytest -q', '/Users/a/.venv/bin/pytest', '/usr/bin/python3 /Users/a/.venv/bin/pytest -q', '/opt/Python.framework/Python -m pytest', 'python3.12 -m unittest discover',
  'node /a/node_modules/.bin/jest --ci', 'node /a/node_modules/jest/bin/jest.js', 'node --max-old-space-size=4096 /a/node_modules/vitest/vitest.mjs run',
  'npm test', 'npm run test:unit', 'node /opt/bin/pnpm test', 'node /opt/bin/pnpm --filter web test', 'npm exec jest', 'yarn test',
  'go test ./...', '/a/.rustup/bin/cargo test', 'cargo nextest run', 'make test', 'make -C api test', 'xcodebuild -scheme App test', 'ruby bin/rails test', 'python manage.py test', 'claude plugin test .',
]) {
  test(`reads a test process: ${command}`, () => expect(isTestProcess(command)).toBe(true))
}

for (const command of [
  'node /a/server.js test', '/usr/bin/python3 /Users/a/test/app.py', '/Users/a/test-project/node_modules/.bin/next dev', 'python3 test_helper.py', 'sh ./run-tests.sh', '/bin/zsh -c source /a/snapshot.sh && eval npm test',
  'claude -p run the test suite', '/a/claude --model haiku fix the failing pytest', 'npm install test', 'npm run build', 'go build ./test', 'cat test', 'vim tests/a.py', 'grep -r pytest .',
  'jest --watch', 'jest --watchAll', 'pytest --version', 'node (vitest 1)', 'node /a/jest-worker/build/workers/processChild.js', '/tmp/go-build1/b001/api.test',
]) {
  test(`does not read a test process: ${command}`, () => expect(isTestProcess(command)).toBe(false))
}

test('a process row names what runs, without paths or interpreter', () => {
  expect(processLabel('/Users/a/.venv/bin/pytest -q')).toBe('pytest -q')
  expect(processLabel('/usr/bin/python3 /Users/a/.venv/bin/pytest -q')).toBe('pytest -q')
  expect(processLabel('/opt/bin/node /opt/bin/pnpm test')).toBe('pnpm test')
  expect(processLabel('/usr/bin/python3 -m pytest')).toBe('python3 -m pytest')
  expect(processLabel('node /a/node_modules/jest/bin/jest.js --ci')).toBe('jest --ci')
})

test('ps times and rows read as they come', () => {
  expect(etimeMs('00:05')).toBe(5000)
  expect(etimeMs('02:05')).toBe(125_000)
  expect(etimeMs('01:02:05')).toBe(3_725_000)
  expect(etimeMs('01-05:37:27')).toBe(106_647_000)
  expect(parseProcesses('  101   1      00:05 npm test\n\n61249 37913 01:00 /bin/zsh -c a b\n')).toEqual([
    { pid: 101, ppid: 1, elapsedMs: 5000, command: 'npm test' },
    { pid: 61249, ppid: 37913, elapsedMs: 60_000, command: '/bin/zsh -c a b' },
  ])
})

const proc = (pid: number, ppid: number, command: string, elapsedMs = 0) => ({ pid, ppid, elapsedMs, command })

test('a run counts once, at its topmost process', () => {
  const rows = [proc(1, 0, 'launchd'), proc(50, 1, '/bin/zsh'), proc(51, 50, 'npm test'), proc(52, 51, 'sh -c jest'), proc(53, 52, 'node /a/.bin/jest'), proc(54, 53, 'node /a/jest-worker/processChild.js')]
  expect(untrackedTestRuns(rows, ENGINE, false).map(p => p.pid)).toEqual([51])
})

test('a run this session started is left to its tool call while it has a row', () => {
  const rows = [proc(1, 0, 'launchd'), proc(ENGINE, 1, 'claude'), proc(901, ENGINE, '/bin/zsh -c a'), proc(902, 901, 'pytest -q'), proc(903, ENGINE, 'go test ./...')]
  expect(untrackedTestRuns(rows, ENGINE, true)).toEqual([])
})

test('a runner under a script no tool call read as a test run is found', () => {
  const rows = [proc(1, 0, 'launchd'), proc(ENGINE, 1, 'claude'), proc(901, ENGINE, '/bin/zsh -c ./ci.sh'), proc(902, 901, 'pytest -q')]
  expect(untrackedTestRuns(rows, ENGINE, false).map(p => p.pid)).toEqual([902])
})

test('a run in a terminal or another session is found, whatever this session is doing', () => {
  const rows = [proc(1, 0, 'launchd'), proc(ENGINE, 1, 'claude'), proc(50, 1, '/bin/zsh'), proc(51, 50, 'pytest -q'), proc(60, 1, 'claude'), proc(61, 60, '/bin/zsh -c a'), proc(62, 61, 'go test ./...')]
  expect(untrackedTestRuns(rows, ENGINE, true).map(p => p.pid)).toEqual([51, 62])
})

test('a pipe or a semicolon hides the exit code, and quotes do not', () => {
  expect(hidesExit('pytest | tail')).toBe(true)
  expect(hidesExit('pytest || true')).toBe(true)
  expect(hidesExit('cd a; pytest')).toBe(true)
  expect(hidesExit('cd a && pytest')).toBe(false)
  expect(hidesExit('pytest -k "a|b"')).toBe(false)
})

test('a verdict comes from the exit code, and from the output where that is hidden', () => {
  expect(testVerdict(false, false, '')).toBe('passed')
  expect(testVerdict(false, false, 'a test named 1 failed')).toBe('passed')
  expect(testVerdict(false, true, 'Exit code 1\n1 failed')).toBe('failed')
  expect(testVerdict(false, true, 'Exit code 5')).toBe('failed')
  expect(testVerdict(false, true, 'The user refused')).toBe('stopped')
  expect(testVerdict(true, false, '1 failed, 2 passed in 0.1s')).toBe('failed')
  expect(testVerdict(true, false, 'FAIL\tapi\t0.1s')).toBe('failed')
  expect(testVerdict(true, false, '3 passed in 0.1s')).toBe('passed')
  expect(testVerdict(true, false, '31 pass\n0 fail')).toBe('passed')
  expect(testVerdict(true, false, 'ok  \tapi\t0.1s')).toBe('passed')
  expect(testVerdict(true, false, 'nothing to go on')).toBe('ended')
})

test('a background verdict comes from its status', () => {
  expect(backgroundVerdict(false, 'completed')).toBe('passed')
  expect(backgroundVerdict(true, 'completed')).toBe('ended')
  expect(backgroundVerdict(true, 'failed')).toBe('failed')
  expect(backgroundVerdict(false, 'killed')).toBe('stopped')
  expect(backgroundVerdict(false, undefined)).toBe('ended')
  expect(notifiedStatuses('<task-id>a</task-id>\n<output-file>x</output-file>\n<status>failed</status><task-id>b</task-id><status>completed</status>')).toEqual({ a: 'failed', b: 'completed' })
  expect(notifiedStatuses('<task-id>a</task-id><task-id>b</task-id><status>killed</status>')).toEqual({ b: 'killed' })
})

test('a running minibar never reads as finished', () => {
  expect(miniFraction({ label: 'a', tools: 300, status: 'running', startedAt: 0 })).toBe(0.9)
  expect(miniFraction({ label: 'a', tools: 3, status: 'done', startedAt: 0 })).toBe(1)
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

test('/bars prints the readings', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  expect((await $.command.run({ command: 'bars' })).text).toBe('42% context  24% 5h  91% 7d')
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
  expect((await ui.find({ type: 'Text', text: /Read the API/ }))?.text).toBe('Read the API · 1 tool · 0s')
  await $.tool.call({ tool: 'Read', file_path: 'b', agentId: 'A1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'c' } as never)
  expect((await ui.find({ type: 'Text', text: /Read the API/ }))?.text).toBe('Read the API · 2 tools · 0s')
  await $.turn.complete(turn({ agentId: 'A1' } as never))
  expect((await ui.find({ type: 'Text', text: /Read the API/ }))?.text).toBe('Read the API · done · 0s')
})

test('running time reads well at every length', () => {
  expect(elapsed(0)).toBe('0s')
  expect(elapsed(45_000)).toBe('45s')
  expect(elapsed(124_000)).toBe('2m 04s')
  expect(elapsed(3_780_000)).toBe('1h 03m')
  expect(elapsed(-5)).toBe('0s')
})

test('a notification names its task ids, and a result its background id', () => {
  expect(notifiedIds('<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>')).toEqual(['abc'])
  expect(notifiedIds('nothing here')).toEqual([])
  expect(backgroundId({ backgroundTaskId: 'b1' })).toBe('b1')
  expect(backgroundId({ taskId: 'm1' })).toBe('m1')
  expect(backgroundId({ stdout: 'x' })).toBeUndefined()
  expect(backgroundId(undefined)).toBeUndefined()
})

const started = (id: string, description: string) => ({ tool: 'Bash', command: 'sleep 99', description, run_in_background: true, fakeResult: { backgroundTaskId: id } }) as never
const testCall = (over: object = {}) => ({ tool: 'Bash', command: 'npm test', description: 'Run the tests', ...over }) as never
const label = /Run the tests/

test('a test run shows while it runs, counts up, and ends passed', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  world(on, { hold: new Promise<void>(resolve => { release = resolve }) })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  const call = $.tool.call(testCall())
  await clock.advance(65_000)
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · 1m 05s')
  release()
  await call
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · passed · 1m 05s')
})

test('a failed run says so in the error color', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(testCall({ fakeAnswer: { result: 'Error: Exit code 1', text: 'Exit code 1\n1 failed', isError: true } }))
  const row = await ui.find({ type: 'Text', text: label })
  expect(row?.text).toBe('Run the tests · failed · 0s')
  expect(row?.props.color).toBe('error')
})

test('a piped run that fails is failed, though the pipe exits clean', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(testCall({ command: 'pytest | tail -5', fakeAnswer: { result: { stdout: '' }, text: '1 failed, 2 passed in 0.1s' } }))
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · failed · 0s')
})

test('a refused test run leaves no row', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(testCall({ fakeAnswer: { deny: 'no' } }))
  expect(await ui.find({ type: 'Text', text: label })).toBeUndefined()
})

test('other commands get no test row', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(testCall({ command: 'npm run build' }))
  expect(await ui.find({ type: 'Text', text: label })).toBeUndefined()
})

test('a test run in a subagent is listed too', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(testCall({ agentId: 'A1' }))
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · passed · 0s')
})

test('a background test run is one row, and ends by its notification', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(testCall({ run_in_background: true, fakeResult: { backgroundTaskId: 'b1' } }))
  await clock.advance(5000)
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · 5s')
  await clock.advance(5000)
  await $.prompt.submit({ text: '<task-notification>\n<task-id>b1</task-id>\n<status>failed</status>\n</task-notification>', wait: false, origin: { kind: 'task-notification' } })
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · failed · 10s')
})

test('a run moved to the background keeps its clock', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  world(on, { hold: new Promise<void>(resolve => { release = resolve }) })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  const call = $.tool.call(testCall({ fakeResult: { backgroundTaskId: 'b1', backgroundedByUser: true } }))
  await clock.advance(30_000)
  release()
  await call
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · 30s')
  await $.prompt.submit({ text: '<task-id>b1</task-id><status>completed</status>', wait: false, origin: { kind: 'task-notification' } })
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · passed · 30s')
})

test('a notification that comes after Stop still gives the verdict', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  on('classic.Stop', () => ({}))
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(testCall({ run_in_background: true, fakeResult: { backgroundTaskId: 'b1' } }))
  await clock.advance(2000)
  await $.classic.Stop({ background_tasks: [] } as never)
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · ended · 2s')
  await clock.advance(9000)
  await $.prompt.submit({ text: '<task-id>b1</task-id><status>completed</status>', wait: false, origin: { kind: 'task-notification' } })
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · passed · 2s')
})

test('a run outside this session shows its true age, then ends with no verdict', async ($, on) => {
  const clock = mock.clock(on)
  let table = `${ENGINE} 1 05:00 claude\n50 1 05:00 /bin/zsh\n51 50 02:00 /a/.venv/bin/pytest -q\n`
  world(on, { ps: () => table })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  expect(await ui.find({ type: 'Text', text: /pytest -q/ })).toBeUndefined()
  await clock.advance(10_000)
  expect((await ui.find({ type: 'Text', text: /pytest -q/ }))?.text).toBe('pytest -q · 2m 00s')
  await clock.advance(5000)
  expect((await ui.find({ type: 'Text', text: /pytest -q/ }))?.text).toBe('pytest -q · 2m 05s')
  table = `${ENGINE} 1 05:00 claude\n50 1 05:00 /bin/zsh\n`
  await clock.advance(5000)
  expect((await ui.find({ type: 'Text', text: /pytest -q/ }))?.text).toBe('pytest -q · ended · 2m 10s')
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ type: 'Text', text: /pytest -q/ })).toBeUndefined()
})

test('a run still going survives the next message and is not listed twice', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { ps: () => `50 1 00:10 /bin/zsh\n51 50 00:10 npm test\n` })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await clock.advance(30_000)
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  await clock.advance(10_000)
  expect((await ui.find({ type: 'Text', text: /npm test/ }))?.text).toBe('npm test · 40s')
  expect(await ui.find({ type: 'Text', text: /\+\d+ more/ })).toBeUndefined()
})

test('a run with a tool call row is not listed again by the scan', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  world(on, { hold: new Promise<void>(resolve => { release = resolve }), ps: () => `${ENGINE} 1 05:00 claude\n901 ${ENGINE} 00:10 /bin/zsh -c a\n902 901 00:10 npm test\n` })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  const call = $.tool.call(testCall())
  await clock.advance(10_000)
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · 10s')
  expect(await ui.find({ type: 'Text', text: /^npm test/ })).toBeUndefined()
  release()
  await call
})

test('without ps the scan stops and nothing else breaks', async ($, on) => {
  const clock = mock.clock(on)
  const calls: string[] = []
  world(on)
  on('process.run', ($, e) => {
    calls.push(e.argv[0] ?? '')
    if (e.argv[0] === 'ps') throw new Error('no ps')
    return { value: { exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await clock.advance(35_000)
  expect(calls).toEqual(['sh', 'ps'])
  expect(await ui.find({ type: 'Text', text: /42% context/ })).toBeDefined()
})

test('without sh there is no scan', async ($, on) => {
  const clock = mock.clock(on)
  const calls: string[] = []
  world(on)
  on('process.run', ($, e) => {
    calls.push(e.argv[0] ?? '')
    throw new Error('no sh')
  })
  await $.session.start(session)
  await clock.advance(35_000)
  expect(calls).toEqual(['sh'])
  expect((await $.command.run({ command: 'bars' })).text).toContain('42% context')
})

test('a stopped background run says so', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(testCall({ run_in_background: true, fakeResult: { backgroundTaskId: 'b1' } }))
  await $.tool.call({ tool: 'TaskStop', task_id: 'b1' } as never)
  expect((await ui.find({ type: 'Text', text: label }))?.text).toBe('Run the tests · stopped · 0s')
})

test('the next message from the person clears finished runs only', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(testCall({ description: 'Finished run' }))
  await $.tool.call(testCall({ description: 'Long run', run_in_background: true, fakeResult: { backgroundTaskId: 'b1' } }))
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ type: 'Text', text: /Finished run/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Long run/ })).toBeDefined()
})

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`test runs draw on ${surface}`, async ($, on) => {
    mock.clock(on)
    world(on)
    await $.session.start({ ...session, surface })
    const ui = await $.ui.mount({ ...mount, surface })
    await $.tool.call(testCall())
    await $.tool.call(testCall({ description: 'Failing run', fakeAnswer: { result: 'x', text: 'Exit code 1', isError: true } }))
    expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Failing run/ })).toBeDefined()
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /◎/ })).toBeDefined()
  })
}

test('a background task is listed with its description, and its time counts up', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(started('b1', 'Run the dev server'))
  expect((await ui.find({ type: 'Text', text: /dev server/ }))?.text).toBe('Run the dev server · 0s')
  await clock.advance(125_000)
  expect((await ui.find({ type: 'Text', text: /dev server/ }))?.text).toBe('Run the dev server · 2m 05s')
})

test('a foreground command is not listed', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' } as never)
  expect(await ui.find({ type: 'Text', text: /List files/ })).toBeUndefined()
})

test('a task leaves the list on its notification, or when it is stopped', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(started('b1', 'First job'))
  await $.tool.call(started('b2', 'Second job'))
  await $.prompt.submit({ text: '<task-notification><task-id>b1</task-id></task-notification>', wait: false, origin: { kind: 'task-notification' } })
  expect(await ui.find({ type: 'Text', text: /First job/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Second job/ })).toBeDefined()
  await $.tool.call({ tool: 'TaskStop', task_id: 'b2' } as never)
  expect(await ui.find({ type: 'Text', text: /Second job/ })).toBeUndefined()
})

test('a person writing a task id does not end the task', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  await $.tool.call(started('b1', 'First job'))
  await $.prompt.submit({ text: '<task-id>b1</task-id>', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ type: 'Text', text: /First job/ })).toBeDefined()
})

test('past four tasks the older ones fold under a count', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  for (let i = 1; i <= 6; i++) await $.tool.call(started('b' + i, 'Job ' + i))
  expect(await ui.find({ type: 'Text', text: /\+2 more/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Job 6/ })).toBeDefined()
})

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`tasks and agents draw on ${surface}`, async ($, on) => {
    mock.clock(on)
    world(on)
    await $.session.start({ ...session, surface })
    const ui = await $.ui.mount({ ...mount, surface })
    await $.tool.call(started('b1', 'Run the dev server'))
    await $.agent.spawn(spawn('Read the API'))
    expect(await ui.find({ type: 'Text', text: /dev server/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Read the API/ })).toBeDefined()
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: />_/ })).toBeDefined()
  })
}

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
