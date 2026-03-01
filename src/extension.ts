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
  const config = getConfig();

  if (!config.enabled) {
    return;
  }

  // Determine workspace root
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  // Verify this is a git repo
  if (!(await isGitRepo(workspaceRoot))) {
    return;
  }

  let repoRoot: string;
  try {
    repoRoot = await getRepoRoot(workspaceRoot);
  } catch {
    return;
  }

  // Set up metadata reader and indexer
  const intelDir = path.join(repoRoot, config.intelDirectory);
  const reader = new MetadataReader(intelDir);
  const indexer = new LineIndexer(reader);

  // --- Blame Provider (gutter annotations) ---
  blameProvider = new BlameProvider(reader, indexer, repoRoot);
  context.subscriptions.push(blameProvider);

  // --- Hover Provider ---
  const hoverProvider = new IntelHoverProvider(blameProvider);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider)
  );

  // --- Tree View Providers (sidebar) ---
  const agentTree = new IntelTreeProvider(reader, 'agent');
  const sessionTree = new IntelTreeProvider(reader, 'session');
  const branchTree = new IntelTreeProvider(reader, 'branch');

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

  // --- Heatmap Decoration Provider (explorer badges) ---
  const heatmapProvider = new HeatmapDecorationProvider(reader, repoRoot);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(heatmapProvider)
  );

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeIntel.toggleBlame', () => {
      blameProvider?.toggle();
      const state = blameProvider
        ? 'enabled'
        : 'disabled';
      vscode.window.showInformationMessage(
        `Claude Intel: Blame annotations toggled`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeIntel.toggleHeatmap', () => {
      blameProvider?.toggleHeatmap();
      vscode.window.showInformationMessage(
        `Claude Intel: Heatmap toggled`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claudeIntel.showPromptDetail',
      (args?: { sha?: string }) => {
        if (!args?.sha) {
          // Try to get info from current cursor position
          const editor = vscode.window.activeTextEditor;
          if (editor && blameProvider) {
            const info = blameProvider.getPromptInfoForLine(
              editor.document.uri,
              editor.selection.active.line
            );
            if (info) {
              showPromptDetailPanel(info, context);
              return;
            }
          }
          vscode.window.showInformationMessage(
            'No AI prompt info found for this line.'
          );
          return;
        }

        // Look up by SHA from the index
        const index = reader.readIndex();
        const indexEntry = index[args.sha];
        if (!indexEntry) {
          vscode.window.showInformationMessage(
            `No Claude Intel data found for commit ${args.sha}`
          );
          return;
        }

        const session = reader.readSession(indexEntry.sessionFile);
        if (!session) {
          return;
        }

        const entry = session.entries[indexEntry.entryIndex];
        if (!entry) {
          return;
        }

        showPromptDetailPanel(
          {
            prompt: entry.prompt,
            promptHash: entry.promptHash,
            agent: session.agent,
            sessionId: session.sessionId,
            commitSha: args.sha,
            commitMessage:
              entry.commits.find((c) => c.sha === args.sha)?.message || '',
            timestamp: entry.timestamp,
            branch: session.branch,
          },
          context
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeIntel.refreshIndex', () => {
      reader.clearCache();
      blameProvider?.refresh();
      agentTree.refresh();
      sessionTree.refresh();
      branchTree.refresh();
      heatmapProvider.refresh();
      vscode.window.showInformationMessage(
        'Claude Intel: Metadata index refreshed'
      );
    })
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

  console.log('[Claude Intel] Extension activated');
}

export function deactivate(): void {
  blameProvider = undefined;
}

/**
 * Show a webview panel with full prompt detail.
 */
function showPromptDetailPanel(
  info: {
    prompt: string;
    promptHash: string;
    agent: string;
    sessionId: string;
    commitSha: string;
    commitMessage: string;
    timestamp: string;
    branch: string;
  },
  context: vscode.ExtensionContext
): void {
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
