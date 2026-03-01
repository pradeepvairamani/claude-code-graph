import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { PromptGraphProvider } from './providers/graphProvider';
import { TranscriptWatcher } from './transcript/watcher';

let graphProvider: PromptGraphProvider | undefined;
let transcriptWatcher: TranscriptWatcher | undefined;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Claude Code Graph');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('[Claude Code Graph] Extension activating...');

  // --- Always register the sidebar webview view provider ---
  graphProvider = new PromptGraphProvider();
  context.subscriptions.push(graphProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'claudeIntel.promptGraph',
      graphProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // --- Register commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeIntel.pickSession', () => {
      if (graphProvider) {
        graphProvider.showPicker();
      } else {
        vscode.window.showWarningMessage('Claude Code Graph: Not available (no workspace detected).');
      }
    })
  );

  // --- Workspace setup ---
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    outputChannel.appendLine('[Claude Code Graph] No workspace folder found');
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  outputChannel.appendLine(`[Claude Code Graph] Workspace root: ${workspaceRoot}`);

  // --- Find Claude Code transcripts and start watching ---
  const claudeProjectDir = findClaudeProjectDir(workspaceRoot, outputChannel);
  outputChannel.appendLine(`[Claude Code Graph] Looking for transcripts in: ${claudeProjectDir || '(not found)'}`);

  if (claudeProjectDir) {
    transcriptWatcher = new TranscriptWatcher(claudeProjectDir);
    transcriptWatcher.start();
    context.subscriptions.push({ dispose: () => transcriptWatcher?.stop() });

    graphProvider.setWatcher(transcriptWatcher, workspaceRoot);

    const sessionCount = transcriptWatcher.getSessionFiles().length;
    outputChannel.appendLine(`[Claude Code Graph] Found ${sessionCount} Claude Code session(s)`);
  } else {
    outputChannel.appendLine('[Claude Code Graph] No Claude Code project directory found for this workspace');
  }

  outputChannel.appendLine('[Claude Code Graph] Extension activated successfully');
}

export function deactivate(): void {
  transcriptWatcher?.stop();
  transcriptWatcher = undefined;
  graphProvider = undefined;
}

/**
 * Find the Claude Code project directory for a workspace.
 * Claude Code stores transcripts in ~/.claude/projects/<slug>/ where
 * <slug> is the cwd path with / replaced by -. The cwd might be the
 * workspace root itself or a parent directory.
 */
function findClaudeProjectDir(
  workspaceRoot: string,
  outputChannel: vscode.OutputChannel
): string | null {
  const projectsBase = path.join(os.homedir(), '.claude', 'projects');
  const fs = require('fs') as typeof import('fs');

  if (!fs.existsSync(projectsBase)) {
    return null;
  }

  // Strategy 1: walk up from workspace root, check exact slug matches
  let current = workspaceRoot;
  while (current && current !== path.dirname(current)) {
    const slug = current.replace(/\//g, '-');
    const candidate = path.join(projectsBase, slug);
    if (fs.existsSync(candidate)) {
      outputChannel.appendLine(`[Claude Code Graph] Matched project dir via path: ${current}`);
      return candidate;
    }
    current = path.dirname(current);
  }

  // Strategy 2: scan project dirs for any whose decoded path is a parent of workspaceRoot
  try {
    const dirs = fs.readdirSync(projectsBase);
    dirs.sort((a: string, b: string) => b.length - a.length);
    for (const dir of dirs) {
      const decoded = dir.replace(/^-/, '/').replace(/-/g, '/');
      if (workspaceRoot.startsWith(decoded) || workspaceRoot === decoded) {
        const candidate = path.join(projectsBase, dir);
        outputChannel.appendLine(`[Claude Code Graph] Matched project dir via scan: ${decoded}`);
        return candidate;
      }
    }
  } catch {
    // ignore scan errors
  }

  return null;
}
