<h1 align="center">claude-bars</h1>

<p align="center"><b>Your context and plan limits as one quiet line, with a thin bar for every subagent.</b></p>

<p align="center">
  <img alt="type: Claude Code mod" src="https://img.shields.io/badge/type-Claude%20Code%20mod-6f42c1?style=flat-square">
  <img alt="tested on: Claude Code 2.1.292" src="https://img.shields.io/badge/tested%20on-Claude%20Code%202.1.292-D97757?style=flat-square">
  <img alt="tests: 20 passing" src="https://img.shields.io/badge/tests-20%20passing-2ea44f?style=flat-square">
</p>

<p align="center"><img src="docs/usage.svg" alt="bars alone, with three finished subagents, from a real terminal session" width="860"></p>

<p align="center"><sub>Only this mod enabled, in a real terminal session: context, plan limits and three finished subagents.</sub></p>

Know how much room you have left at a glance, and see what your subagents are doing without opening anything. It takes one line above the prompt and costs no tokens.

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
- **Subagent bars:** One thin bar per subagent, with its task and tool count. It fills when the agent ends.
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
- It sees subagents only. Separate sessions you start from the app get no bar.
- The drawn bars are for the desktop app, VS Code and mobile. I have only seen them in the terminal and the desktop app.
- If you use the `skins` mod, run `/skin band off` so its rings do not show as well.

## Develop

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## Credits

- The way Compact gets its own dispatch comes from [skins](https://github.com/hellosverre/claude-skins) (MIT).

## License

Not chosen yet, so all rights are reserved for now.
