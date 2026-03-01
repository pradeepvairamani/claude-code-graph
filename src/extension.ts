import * as vscode from 'vscode';
import * as path from 'path';
import { MetadataReader } from './metadata/reader';
import { LineIndexer } from './metadata/indexer';
import { BlameProvider } from './providers/blameProvider';
import { IntelHoverProvider } from './providers/hoverProvider';
import { IntelTreeProvider } from './providers/treeProvider';
import { HeatmapDecorationProvider } from './providers/heatmapProvider';
import { getRepoRoot, isGitRepo } from './utils/git';
import { getConfig, onConfigChange } from './utils/config';

let blameProvider: BlameProvider | undefined;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Claude Git Intel');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('[Claude Intel] Extension activating...');

  const config = getConfig();

  // --- Always register tree views so VS Code doesn't show "no data provider" ---
  // They'll return empty arrays until data is available.
  const agentTree = new IntelTreeProvider(null, 'agent');
  const sessionTree = new IntelTreeProvider(null, 'session');
  const branchTree = new IntelTreeProvider(null, 'branch');

  context.subscriptions.push(
    vscode.window.createTreeView('claudeIntel.byAgent', {
      treeDataProvider: agentTree,
    })
  );
  context.subscriptions.push(
    vscode.window.createTreeView('claudeIntel.bySession', {
      treeDataProvider: sessionTree,
    })
  );
  context.subscriptions.push(
    vscode.window.createTreeView('claudeIntel.byBranch', {
      treeDataProvider: branchTree,
    })
  );

  // --- Always register commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeIntel.toggleBlame', () => {
      if (!blameProvider) {
        vscode.window.showWarningMessage('Claude Intel: No git repo detected in this workspace.');
        return;
      }
      blameProvider.toggle();
      vscode.window.showInformationMessage('Claude Intel: Blame annotations toggled');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeIntel.toggleHeatmap', () => {
      if (!blameProvider) {
        vscode.window.showWarningMessage('Claude Intel: No git repo detected in this workspace.');
        return;
      }
      blameProvider.toggleHeatmap();
      vscode.window.showInformationMessage('Claude Intel: Heatmap toggled');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeIntel.showPromptDetail', (args?: { sha?: string }) => {
      handleShowPromptDetail(args, context, outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeIntel.refreshIndex', () => {
      if (currentReader) {
        currentReader.clearCache();
      }
      blameProvider?.refresh();
      agentTree.refresh();
      sessionTree.refresh();
      branchTree.refresh();
      currentHeatmapProvider?.refresh();
      vscode.window.showInformationMessage('Claude Intel: Metadata index refreshed');
    })
  );

  // --- Now do the conditional setup that depends on workspace/git ---

  if (!config.enabled) {
    outputChannel.appendLine('[Claude Intel] Disabled via config');
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    outputChannel.appendLine('[Claude Intel] No workspace folder found');
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  outputChannel.appendLine(`[Claude Intel] Workspace root: ${workspaceRoot}`);

  if (!(await isGitRepo(workspaceRoot))) {
    outputChannel.appendLine('[Claude Intel] Not a git repo');
    return;
  }

  let repoRoot: string;
  try {
    repoRoot = await getRepoRoot(workspaceRoot);
  } catch {
    outputChannel.appendLine('[Claude Intel] Failed to get repo root');
    return;
  }

  outputChannel.appendLine(`[Claude Intel] Repo root: ${repoRoot}`);

  // Set up metadata reader and indexer
  const intelDir = path.join(repoRoot, config.intelDirectory);
  outputChannel.appendLine(`[Claude Intel] Intel dir: ${intelDir}`);

  const reader = new MetadataReader(intelDir);
  currentReader = reader;
  const indexer = new LineIndexer(reader);

  // Wire the reader into the tree providers now that we have data
  agentTree.setReader(reader);
  sessionTree.setReader(reader);
  branchTree.setReader(reader);

  if (!reader.exists()) {
    outputChannel.appendLine('[Claude Intel] Intel directory does not exist — run seed-demo to generate data');
  } else {
    const sessions = reader.readAllSessions();
    const index = reader.readIndex();
    outputChannel.appendLine(`[Claude Intel] Loaded ${sessions.length} sessions, ${Object.keys(index).length} indexed commits`);
  }

  // Refresh trees now that reader is connected
  agentTree.refresh();
  sessionTree.refresh();
  branchTree.refresh();

  // --- Blame Provider (gutter annotations) ---
  blameProvider = new BlameProvider(reader, indexer, repoRoot);
  context.subscriptions.push(blameProvider);

  // --- Hover Provider ---
  const hoverProvider = new IntelHoverProvider(blameProvider);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider)
  );

  // --- Heatmap Decoration Provider (explorer badges) ---
  const heatmapProvider = new HeatmapDecorationProvider(reader, repoRoot);
  currentHeatmapProvider = heatmapProvider;
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(heatmapProvider)
  );

  // --- Config change listener ---
  context.subscriptions.push(
    onConfigChange(() => {
      reader.clearCache();
      blameProvider?.refresh();
      agentTree.refresh();
      sessionTree.refresh();
      branchTree.refresh();
      heatmapProvider.refresh();
    })
  );

  outputChannel.appendLine('[Claude Intel] Extension activated successfully');
}

// Module-level refs for commands that need them
let currentReader: MetadataReader | undefined;
let currentHeatmapProvider: HeatmapDecorationProvider | undefined;

export function deactivate(): void {
  blameProvider = undefined;
  currentReader = undefined;
  currentHeatmapProvider = undefined;
}

function handleShowPromptDetail(
  args: { sha?: string } | undefined,
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
): void {
  if (!currentReader) {
    vscode.window.showWarningMessage('Claude Intel: No metadata available in this workspace.');
    return;
  }

  if (!args?.sha) {
    const editor = vscode.window.activeTextEditor;
    if (editor && blameProvider) {
      const info = blameProvider.getPromptInfoForLine(
        editor.document.uri,
        editor.selection.active.line
      );
      if (info) {
        showPromptDetailPanel(info);
        return;
      }
    }
    vscode.window.showInformationMessage('No AI prompt info found for this line.');
    return;
  }

  const index = currentReader.readIndex();
  const indexEntry = index[args.sha];
  if (!indexEntry) {
    vscode.window.showInformationMessage(`No Claude Intel data found for commit ${args.sha}`);
    return;
  }

  const session = currentReader.readSession(indexEntry.sessionFile);
  if (!session) {
    return;
  }

  const entry = session.entries[indexEntry.entryIndex];
  if (!entry) {
    return;
  }

  showPromptDetailPanel({
    prompt: entry.prompt,
    promptHash: entry.promptHash,
    agent: session.agent,
    sessionId: session.sessionId,
    commitSha: args.sha,
    commitMessage: entry.commits.find((c) => c.sha === args.sha)?.message || '',
    timestamp: entry.timestamp,
    branch: session.branch,
  });
}

function showPromptDetailPanel(info: {
  prompt: string;
  promptHash: string;
  agent: string;
  sessionId: string;
  commitSha: string;
  commitMessage: string;
  timestamp: string;
  branch: string;
}): void {
  const panel = vscode.window.createWebviewPanel(
    'claudeIntelPrompt',
    `Prompt: ${info.commitSha}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prompt Detail</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
      line-height: 1.6;
    }
    h1 { font-size: 1.4em; margin-bottom: 0.5em; }
    .field { margin-bottom: 12px; }
    .label {
      font-weight: bold;
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .value {
      margin-top: 4px;
      padding: 8px 12px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textLink-foreground);
      border-radius: 3px;
    }
    .prompt-text {
      white-space: pre-wrap;
      font-size: 1.05em;
    }
    code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textBlockQuote-background);
      padding: 2px 6px;
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <h1>Claude Git Intel &mdash; Prompt Detail</h1>

  <div class="field">
    <div class="label">Prompt</div>
    <div class="value prompt-text">${escapeHtml(info.prompt)}</div>
  </div>

  <div class="field">
    <div class="label">Agent</div>
    <div class="value"><code>${escapeHtml(info.agent)}</code></div>
  </div>

  <div class="field">
    <div class="label">Commit</div>
    <div class="value"><code>${escapeHtml(info.commitSha)}</code> &mdash; ${escapeHtml(info.commitMessage)}</div>
  </div>

  <div class="field">
    <div class="label">Branch</div>
    <div class="value"><code>${escapeHtml(info.branch)}</code></div>
  </div>

  <div class="field">
    <div class="label">Timestamp</div>
    <div class="value">${escapeHtml(new Date(info.timestamp).toLocaleString())}</div>
  </div>

  <div class="field">
    <div class="label">Session ID</div>
    <div class="value"><code>${escapeHtml(info.sessionId)}</code></div>
  </div>

  <div class="field">
    <div class="label">Prompt Hash</div>
    <div class="value"><code>${escapeHtml(info.promptHash)}</code></div>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
