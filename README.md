# Claude Code Graph

See what Claude actually did. Every prompt, every subagent, every file change — rendered as an interactive graph right in your VS Code sidebar.

![Claude Code Graph in action](media/screenshots/prompt-graph.png)

## Features

- **Prompt Graph** — a git-graph-style timeline of your entire Claude Code session. Each node is a prompt; branches show subagent spawns.
- **Click to Inspect** — select any node to see the full prompt text, model used, files changed, and subagent details.
- **Session Picker** — switch between sessions with a dropdown. See prompt counts, subagent counts, file changes, and branch info at a glance.
- **Live Updates** — the graph refreshes automatically as Claude Code runs.
- **Search & Filter** — filter prompts and files to find exactly what you're looking for.

## Requirements

- VS Code 1.85+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — use it at least once in your workspace so transcript files exist under `~/.claude/projects/`.

## Getting Started

1. Install the extension.
2. Open a project where you've used Claude Code.
3. Click the **Claude Code Graph** icon in the Activity Bar.
4. Pick a session from the dropdown — the graph appears instantly.

## License

[MIT](LICENSE)
