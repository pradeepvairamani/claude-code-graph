# Claude Code Graph

Visualize Claude Code sessions as interactive graphs inside VS Code.

## Features

- **Prompt Graph** — see every prompt, subagent call, and file change from a Claude Code session rendered as a connected node graph in the sidebar.
- **Session Picker** — quickly switch between Claude Code sessions recorded in the current workspace.
- **Live Watching** — automatically detects new transcript files as Claude Code runs.

## Requirements

- VS Code 1.85+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and used in the workspace at least once (so transcript files exist under `~/.claude/projects/`).

## Usage

1. Install the extension.
2. Open a project where you have previously used Claude Code.
3. Click the **Claude Code Graph** icon in the Activity Bar.
4. Use the **Claude Code Graph: Pick Session** command (`Cmd+Shift+P`) to switch sessions.

## Extension Settings

This extension does not add any VS Code settings at this time.

## License

[MIT](LICENSE)
