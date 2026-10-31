<h1 align="center">claude-bars</h1>

<p align="center"><b>Your context and plan limits as one quiet line, with every subagent and background task and how long each has been running.</b></p>

<p align="center">
  <img alt="type: Claude Code mod" src="https://img.shields.io/badge/type-Claude%20Code%20mod-6f42c1?style=flat-square">
  <img alt="tested on: Claude Code 2.1.292" src="https://img.shields.io/badge/tested%20on-Claude%20Code%202.1.292-D97757?style=flat-square">
  <img alt="tests: 31 passing" src="https://img.shields.io/badge/tests-31%20passing-2ea44f?style=flat-square">
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-555?style=flat-square">
</p>

<p align="center"><img src="docs/usage.svg" alt="bars alone, with three finished subagents, from a real terminal session" width="860"></p>

<p align="center"><sub>Only this mod enabled, combined from two real terminal sessions: agents, then background commands with their timers.</sub></p>

Know how much room you have left, and what is still running, at a glance. That dev server Claude started twenty minutes ago stays in view with its description and a running clock. It costs no tokens.

## Install

In a terminal, inside Claude Code:

```
/plugin install bars --marketplace YlitaloJuha/claude-bars
```

Or from a shell:

```bash
claude plugin install bars --marketplace YlitaloJuha/claude-bars
```

In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `YlitaloJuha/claude-bars`, then Add plugin.

> [!NOTE]
> This repository is private for now. Installing needs read access and a GitHub credential on your machine, such as `gh auth login` then `gh auth setup-git`.

## What it does

- **Context and limits:** Context window, 5-hour and 7-day limits as thin bars. They only change colour from 70% used.
- **Background tasks:** Each background command with a terminal icon, its description and a counting timer. It leaves the list when it ends.
- **Agents:** Each subagent with an icon, a thin bar, its task, tool count and running time. The bar fills when the agent ends.
- **Stays small:** The newest four of each show. Older ones fold under `+2 more` and open when you hover over the list.
- **Compact button:** Appears on the line from 70% context, and hides while a turn runs.
- **Works alone, shares when it can:** If you also install [`claude-afk`](https://github.com/YlitaloJuha/claude-afk), [`claude-wrap-up`](https://github.com/YlitaloJuha/claude-wrap-up) or [`claude-todos`](https://github.com/YlitaloJuha/claude-todos), they put their controls on this line instead of their own row.

<p align="center"><img src="docs/desktop.png" alt="bars in the desktop app, with the todos, AFK and wrap-up controls on the same line" width="660"></p>

<p align="center"><sub>In the desktop app, with `todos`, `afk` and `wrap-up` also installed: their controls share the line.</sub></p>

## Commands

| Command | What it does |
|---|---|
| `/bars` | Print your context and plan limits |

## What it costs

None. It makes no model calls.

## What it can reach

No network, no shell commands and no file access through the mod API. It reads usage and the subagent list from Claude Code, and runs `/compact` only when you press the button. Run `claude plugin validate .` in this repository to list every call it makes.

## Limits

- Claude Code reports no percent-done for an agent, so a subagent bar shows activity: it grows with tool calls up to 90%, then fills when the agent ends.
- It sees this session only. Separate sessions you start from the app are not listed.
- The hover list has only been checked in tests, and it needs a pointer: where there is none, the older rows stay folded.
- Tasks are known from the moment they start in this session, so ones started before a resume are not listed.
- The drawn bars are for the desktop app, VS Code and mobile. I have only seen them in the terminal and the desktop app.
- If you use the `skins` mod, run `/skin band off` so its rings do not show as well.

## Develop

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## Credits

- The idea of a usage band above the prompt, and the way Compact gets its own dispatch, come from [skins](https://github.com/hellosverre/claude-skins) by hellosverre (MIT).
- The list of prompt origins no person sent comes from [cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal (MIT).

## License and warranty

[MIT](LICENSE). `THIRD_PARTY_LICENSES.md` covers the parts that came from other projects.

Provided **as is, with no warranty of any kind**. You use it at your own risk, and the author is not liable for anything that results from using it, including lost work, usage charges or changes to your code.
