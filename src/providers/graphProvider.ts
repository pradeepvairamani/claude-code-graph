import * as vscode from 'vscode';
import * as path from 'path';
import type { SessionGraph, FileChange } from '../transcript/types';
import { TranscriptWatcher } from '../transcript/watcher';

/**
 * Content provider for virtual diff documents.
 * Serves before/after file content for the diff editor.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  setContent(uri: string, content: string): void {
    this.contents.set(uri, content);
    this._onDidChange.fire(vscode.Uri.parse(uri));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) || '';
  }

  clear(): void {
    this.contents.clear();
  }

  dispose(): void {
    this.contents.clear();
    this._onDidChange.dispose();
  }
}

/**
 * Provides the git-graph-style webview for visualizing
 * prompts, subagents, and file changes.
 * Implements WebviewViewProvider to render in the sidebar.
 */
export class PromptGraphProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private sidebarView: vscode.WebviewView | null = null;
  private currentGraph: SessionGraph | null = null;
  private currentSessionPath: string | null = null;
  private disposables: vscode.Disposable[] = [];
  private diffProvider: DiffContentProvider;
  private watcher: TranscriptWatcher | null = null;
  private workspaceRoot: string = '';

  constructor() {
    this.diffProvider = new DiffContentProvider();
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider('claude-diff', this.diffProvider)
    );
  }

  /**
   * Connect a transcript watcher. Call this once the Claude project dir is found.
   */
  setWatcher(watcher: TranscriptWatcher, workspaceRoot: string): void {
    this.watcher = watcher;
    this.workspaceRoot = workspaceRoot;

    // Listen for live transcript updates
    this.watcher.on('update', (graph: SessionGraph, filePath: string) => {
      if (this.currentSessionPath === filePath) {
        this.currentGraph = graph;
        this.updateWebview();
      }
    });

    // If the sidebar is already visible, load data now
    if (this.sidebarView) {
      this.loadMostRecentSession();
      this.updateWebview();
    }
  }

  /**
   * Called by VS Code when the sidebar view becomes visible.
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.sidebarView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.onDidReceiveMessage(
      (msg) => this.handleWebviewMessage(msg),
      null,
      this.disposables
    );

    webviewView.onDidDispose(() => {
      this.sidebarView = null;
      this.webviewInitialized = false;
    }, null, this.disposables);

    // Load the most recent session if we don't have one
    if (!this.currentGraph && this.watcher) {
      this.loadMostRecentSession();
    }

    this.webviewInitialized = false;

    this.updateWebview();
  }

  private loadMostRecentSession(): void {
    if (!this.watcher) { return; }
    const sessions = this.watcher.getSessionFiles();
    if (sessions.length > 0) {
      this.currentSessionPath = sessions[0].path;
      try {
        this.currentGraph = this.watcher.parseMostRecentSession();
      } catch (e) {
        console.error('[Claude Code Graph] Failed to parse session:', e);
        this.currentGraph = null;
      }
    }
  }

  /**
   * Switch to a specific session by ID.
   */
  switchSession(sessionId: string): void {
    if (!this.watcher) { return; }
    const sessions = this.watcher.getSessionFiles();
    const session = sessions.find(s => s.sessionId === sessionId);
    if (session) {
      this.currentSessionPath = session.path;
      this.currentGraph = this.watcher.parseSessionById(sessionId);
      this.diffProvider.clear();
      this.fullRebuildWebview();
    }
  }

  /**
   * Show a session picker and then switch to the selected session.
   */
  async showPicker(): Promise<void> {
    if (!this.watcher) { return; }
    const sessions = this.watcher.getSessionFiles();

    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No Claude Code sessions found.');
      return;
    }

    const watcher = this.watcher;
    const items = sessions.map(s => {
      const graph = watcher.parseSessionById(s.sessionId);
      const firstPrompt = graph?.prompts[0]?.prompt || 'Empty session';
      const truncated = firstPrompt.length > 80
        ? firstPrompt.slice(0, 77) + '...'
        : firstPrompt;
      return {
        label: truncated,
        description: s.sessionId.slice(0, 8),
        detail: `${s.mtime.toLocaleString()} — ${graph?.prompts.length || 0} prompts, ${graph?.totalSubagents || 0} subagents`,
        sessionId: s.sessionId,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a Claude Code session to visualize',
    });

    if (picked) {
      this.switchSession(picked.sessionId);
    }
  }

  /**
   * Handle messages from the webview.
   */
  private async handleWebviewMessage(msg: {
    type: string;
    nodeId?: string;
    filePath?: string;
    sessionId?: string;
    nodeType?: string;
    fileIndex?: number;
  }): Promise<void> {
    switch (msg.type) {
      case 'openFile': {
        if (msg.filePath) {
          const uri = vscode.Uri.file(msg.filePath);
          try {
            await vscode.commands.executeCommand('vscode.open', uri);
          } catch {
            vscode.window.showWarningMessage(`Cannot open: ${msg.filePath}`);
          }
        }
        break;
      }
      case 'showDiff': {
        await this.showPromptDiff(msg.nodeId, msg.nodeType, msg.fileIndex);
        break;
      }
      case 'switchSession': {
        if (msg.sessionId) {
          this.switchSession(msg.sessionId);
        }
        break;
      }
      case 'viewOutput': {
        const prompt = this.currentGraph?.prompts.find(p => p.id === msg.nodeId);
        if (prompt?.response) {
          const doc = await vscode.workspace.openTextDocument({
            content: prompt.response,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, { preview: true });
        }
        break;
      }
      case 'refresh': {
        if (this.currentSessionPath && this.watcher) {
          const sessionId = path.basename(this.currentSessionPath, '.jsonl');
          this.currentGraph = this.watcher.parseSessionById(sessionId);
          this.fullRebuildWebview();
        }
        break;
      }
    }
  }

  /**
   * Show a diff for a specific file change within a prompt or subagent.
   */
  private async showPromptDiff(
    nodeId: string | undefined,
    nodeType: string | undefined,
    fileIndex: number | undefined
  ): Promise<void> {
    if (!this.currentGraph || nodeId === undefined || fileIndex === undefined) { return; }

    let fileChange: FileChange | undefined;
    let label = '';

    if (nodeType === 'subagent') {
      // Find subagent
      const agentId = nodeId;
      for (const p of this.currentGraph.prompts) {
        for (const sa of p.subagents) {
          if (sa.agentId === agentId) {
            fileChange = sa.fileChanges[fileIndex];
            label = `[${sa.agentType}] ${sa.description}`;
            break;
          }
        }
        if (fileChange) { break; }
      }
    } else {
      // Find prompt
      const prompt = this.currentGraph.prompts.find(p => p.id === nodeId);
      if (prompt) {
        fileChange = prompt.fileChanges[fileIndex];
        label = prompt.prompt.slice(0, 50);
      }
    }

    if (!fileChange) { return; }

    const fileName = path.basename(fileChange.filePath);
    const before = fileChange.contentBefore || '';
    const after = fileChange.contentAfter || '';

    // Set content for the virtual documents
    const beforeUri = `claude-diff:before/${encodeURIComponent(nodeId || '')}/${fileIndex}/${fileName}`;
    const afterUri = `claude-diff:after/${encodeURIComponent(nodeId || '')}/${fileIndex}/${fileName}`;

    this.diffProvider.setContent(beforeUri, before);
    this.diffProvider.setContent(afterUri, after);

    const diffTitle = `${fileName} (${fileChange.changeType === 'create' ? 'created' : 'edited'} by: ${label})`;

    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.parse(beforeUri),
      vscode.Uri.parse(afterUri),
      diffTitle
    );
  }

  private webviewInitialized = false;

  private updateWebview(): void {
    const webview = this.sidebarView?.webview;
    if (!webview) { return; }

    const sessions = this.watcher?.getSessionFiles() || [];
    const sessionList = sessions.map(s => ({ id: s.sessionId, mtime: s.mtime.toISOString() }));
    const lightGraph = this.buildLightGraph(this.currentGraph);

    if (!this.webviewInitialized) {
      // First render: set full HTML
      webview.html = this.buildHtml(lightGraph, sessionList);
      this.webviewInitialized = true;
    } else {
      // Subsequent updates: send data via postMessage to preserve UI state
      webview.postMessage({
        type: 'dataUpdate',
        graph: lightGraph,
        sessions: sessionList,
      });
    }
  }

  /**
   * Force a full HTML rebuild (e.g. on session switch).
   */
  private fullRebuildWebview(): void {
    this.webviewInitialized = false;
    this.updateWebview();
  }

  /**
   * Build a lightweight graph with deduped files and no content blobs.
   */
  private buildLightGraph(graph: SessionGraph | null): Record<string, unknown> | null {
    if (!graph) { return null; }

    const dedupFiles = (files: FileChange[]) => {
      const seen = new Map<string, Record<string, unknown>>();
      for (const fc of files) {
        if (!seen.has(fc.filePath)) {
          seen.set(fc.filePath, {
            filePath: fc.filePath,
            toolName: fc.toolName,
            changeType: fc.changeType,
            timestamp: fc.timestamp,
            hasDiff: fc.contentAfter !== null,
          });
        }
      }
      return Array.from(seen.values());
    };

    const lightGraph: Record<string, unknown> = {
      ...graph,
      prompts: graph.prompts.map(p => ({
        ...p,
        response: !!p.response,
        fileChanges: dedupFiles(p.fileChanges),
        subagents: p.subagents.map(sa => ({
          ...sa,
          fileChanges: dedupFiles(sa.fileChanges),
        })),
      })),
    };

    // Recalculate file change totals from deduplicated data
    let total = 0;
    for (const p of (lightGraph.prompts as Array<{ fileChanges: unknown[]; subagents: Array<{ fileChanges: unknown[] }> }>)) {
      total += p.fileChanges.length;
      for (const sa of p.subagents) {
        total += sa.fileChanges.length;
      }
    }
    lightGraph.totalFileChanges = total;

    return lightGraph;
  }

  private buildHtml(
    lightGraph: Record<string, unknown> | null,
    availableSessions: Array<{ id: string; mtime: string }>
  ): string {
    // Escape </script> sequences to prevent premature tag closure
    const safeJson = (obj: unknown) => JSON.stringify(obj).replace(/<\//g, '<\\/');
    const graphJson = safeJson(lightGraph);
    const sessionsJson = safeJson(availableSessions);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Code Graph</title>
  <style>
    ${this.getStyles()}
  </style>
</head>
<body>
  <div id="header">
    <h1>Claude Code Graph</h1>
    <div id="controls">
      <select id="sessionPicker"></select>
      <button id="refreshBtn" title="Refresh">&#x21bb;</button>
    </div>
  </div>
  <div id="stats"><span id="stats-text"></span><span id="stats-toggle">▾ Stats</span></div>
  <div id="stats-dashboard"><div class="dash-inner" id="stats-dashboard-inner"></div></div>
  <div id="search-bar">
    <input id="searchInput" type="text" placeholder="Filter prompts or files..." />
  </div>
  <div id="graph-container">
    <div id="graph"></div>
    <div id="resize-handle"></div>
    <div id="detail-panel">
      <div id="detail-content">
        <p class="placeholder">Click a node to see details</p>
      </div>
    </div>
  </div>

  <script id="graph-data" type="application/json">${graphJson}</script>
  <script id="sessions-data" type="application/json">${sessionsJson}</script>
  <script>
    ${this.getScript()}
  </script>
</body>
</html>`;
  }

  private getStyles(): string {
    return `
      * { margin: 0; padding: 0; box-sizing: border-box; }

      body {
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
        color: var(--vscode-foreground, #ccc);
        background: var(--vscode-editor-background, #1e1e1e);
        overflow: hidden;
        height: 100vh;
        display: flex;
        flex-direction: column;
      }

      #header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-panel-border, #333);
        gap: 8px;
        flex-shrink: 0;
      }
      #header h1 { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; }

      #controls { display: flex; gap: 8px; align-items: center; min-width: 0; flex: 1; }
      #sessionPicker {
        background: var(--vscode-input-background, #333);
        color: var(--vscode-input-foreground, #ccc);
        border: 1px solid var(--vscode-input-border, #555);
        padding: 4px 8px; border-radius: 3px; font-size: 12px; min-width: 0; flex: 1;
      }
      #refreshBtn {
        background: var(--vscode-button-secondaryBackground, #333);
        color: var(--vscode-button-secondaryForeground, #ccc);
        border: 1px solid var(--vscode-input-border, #555);
        padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 14px;
      }
      #refreshBtn:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }

      #stats {
        padding: 6px 12px; font-size: 11px;
        color: var(--vscode-descriptionForeground, #888);
        border-bottom: 1px solid var(--vscode-panel-border, #333);
        cursor: pointer; user-select: none;
        display: flex; align-items: center; justify-content: space-between;
        flex-shrink: 0;
      }
      #stats:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
      #stats-toggle { font-size: 11px; opacity: 0.45; flex-shrink: 0; margin-left: 6px; line-height: 1; }

      /* Stat pills in the stats bar */
      .stat-pill { display: inline-flex; align-items: baseline; gap: 3px; margin-right: 10px; }
      .stat-pill strong { font-size: 12px; font-weight: 700; }
      .stat-pill .spl { font-size: 10px; color: var(--vscode-descriptionForeground, #888); }
      .sp-prompts strong { color: var(--vscode-textLink-foreground, #3794ff); }
      .sp-agents strong  { color: var(--vscode-terminal-ansiMagenta, #bc89bd); }
      .sp-files strong   { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
      .sp-tokens strong  { color: var(--vscode-terminal-ansiCyan, #4fc3f7); }

      /* Stats dashboard */
      #stats-dashboard {
        display: none; overflow-y: auto; flex-shrink: 0;
        border-bottom: 1px solid var(--vscode-panel-border, #333);
        max-height: 340px;
      }
      #stats-dashboard.visible { display: block; }
      .dash-inner { padding: 0; }
      .dash-section { padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
      .dash-section:last-child { border-bottom: none; }
      .dash-section h4 {
        font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
        color: var(--vscode-descriptionForeground, #888); margin-bottom: 8px;
      }

      /* Overview cards */
      .overview-cards { display: flex; gap: 5px; }
      .overview-card {
        flex: 1; background: var(--vscode-textBlockQuote-background, #252526);
        border-radius: 4px; padding: 7px 8px; border-top: 2px solid transparent;
      }
      .overview-card .ov-value { font-size: 15px; font-weight: 700; line-height: 1.2; }
      .overview-card .ov-label { font-size: 9px; color: var(--vscode-descriptionForeground, #888); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.04em; }
      .oc-prompts { border-top-color: var(--vscode-textLink-foreground, #3794ff); }
      .oc-prompts .ov-value { color: var(--vscode-textLink-foreground, #3794ff); }
      .oc-agents  { border-top-color: var(--vscode-terminal-ansiMagenta, #bc89bd); }
      .oc-agents  .ov-value { color: var(--vscode-terminal-ansiMagenta, #bc89bd); }
      .oc-dur     { border-top-color: var(--vscode-terminal-ansiGreen, #73c991); }
      .oc-dur     .ov-value { color: var(--vscode-terminal-ansiGreen, #73c991); }
      .oc-files   { border-top-color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
      .oc-files   .ov-value { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
      .session-started { font-size: 10px; color: var(--vscode-descriptionForeground, #888); margin-top: 7px; }
      .session-started strong { color: var(--vscode-foreground, #ccc); font-weight: 600; }

      /* Cost banner */
      .cost-banner {
        background: rgba(115, 201, 145, 0.07); border: 1px solid rgba(115, 201, 145, 0.2);
        border-radius: 4px; padding: 9px 12px; display: flex; align-items: center;
        justify-content: space-between; margin-bottom: 8px;
      }
      .cost-amount { font-size: 22px; font-weight: 700; color: var(--vscode-terminal-ansiGreen, #73c991); line-height: 1; }
      .cost-sublabel { font-size: 10px; color: var(--vscode-descriptionForeground, #888); margin-top: 3px; }
      .cost-right { font-size: 10px; color: var(--vscode-descriptionForeground, #888); text-align: right; line-height: 1.7; }

      /* Token row */
      .token-row { display: flex; gap: 5px; }
      .token-item { flex: 1; background: var(--vscode-textBlockQuote-background, #252526); border-radius: 3px; padding: 5px 6px; text-align: center; }
      .token-item .tok-val { font-size: 11px; font-weight: 600; }
      .token-item .tok-lbl { font-size: 9px; color: var(--vscode-descriptionForeground, #888); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.03em; }
      .tok-in    { color: var(--vscode-textLink-foreground, #3794ff); }
      .tok-out   { color: var(--vscode-terminal-ansiGreen, #73c991); }
      .tok-cache { color: var(--vscode-terminal-ansiMagenta, #bc89bd); }

      /* Tool bars */
      .tool-bar-list { display: flex; flex-direction: column; gap: 6px; }
      .tool-bar-item { display: flex; align-items: center; gap: 8px; }
      .tool-bar-name { width: 72px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
      .tool-bar-track { flex: 1; height: 6px; background: var(--vscode-textBlockQuote-background, #252526); border-radius: 3px; overflow: hidden; }
      .tool-bar-fill { height: 100%; background: var(--vscode-terminal-ansiCyan, #4fc3f7); border-radius: 3px; }
      .tool-bar-count { font-size: 10px; font-weight: 600; color: var(--vscode-descriptionForeground, #888); width: 24px; text-align: right; flex-shrink: 0; }

      /* File stat list */
      .file-stat-list { list-style: none; display: flex; flex-direction: column; gap: 1px; }
      .file-stat-item { display: flex; align-items: center; gap: 8px; font-size: 11px; padding: 3px 6px; border-radius: 3px; }
      .file-stat-item:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
      .file-stat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      .file-stat-badge {
        flex-shrink: 0; font-size: 9px; font-weight: 700;
        background: rgba(79, 195, 247, 0.12); color: var(--vscode-terminal-ansiCyan, #4fc3f7);
        padding: 1px 6px; border-radius: 8px; min-width: 22px; text-align: center;
      }

      #search-bar {
        padding: 6px 12px;
        border-bottom: 1px solid var(--vscode-panel-border, #333);
        flex-shrink: 0;
      }
      #searchInput {
        width: 100%;
        background: var(--vscode-input-background, #333);
        color: var(--vscode-input-foreground, #ccc);
        border: 1px solid var(--vscode-input-border, #555);
        padding: 5px 8px; border-radius: 3px; font-size: 12px;
        outline: none;
      }
      #searchInput:focus {
        border-color: var(--vscode-focusBorder, #007fd4);
      }
      #searchInput::placeholder {
        color: var(--vscode-input-placeholderForeground, #888);
      }

      .graph-row.filtered-out { display: none; }

      .copy-btn {
        background: none; border: none; cursor: pointer; padding: 2px 6px;
        color: var(--vscode-descriptionForeground, #888); font-size: 11px;
        border-radius: 3px; vertical-align: middle;
      }
      .copy-btn:hover {
        background: var(--vscode-toolbar-hoverBackground, #383838);
        color: var(--vscode-foreground, #ccc);
      }
      .copy-btn.copied { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }

      .view-output-btn {
        background: var(--vscode-button-secondaryBackground, #3a3d41);
        color: var(--vscode-button-secondaryForeground, #ccc);
        border: none; cursor: pointer; padding: 4px 12px;
        border-radius: 3px; font-size: 12px;
      }
      .view-output-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground, #45494e);
      }

      #graph-container { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
      #graph { flex: 1; overflow-y: auto; overflow-x: auto; padding: 8px 10px; min-height: 60px; }

      #resize-handle {
        height: 5px; cursor: ns-resize; flex-shrink: 0;
        background: var(--vscode-panel-border, #333);
        display: none;
      }
      #resize-handle:hover, #resize-handle.dragging {
        background: var(--vscode-focusBorder, #007fd4);
      }

      #detail-panel {
        overflow-y: auto; padding: 0;
        display: none; min-height: 60px;
        border-top: 2px solid var(--vscode-textLink-foreground, #3794ff);
      }
      .detail-node-header {
        padding: 8px 12px; display: flex; align-items: center; justify-content: space-between;
        background: var(--vscode-sideBar-background, #252526);
        border-bottom: 1px solid var(--vscode-panel-border, #333);
        flex-shrink: 0;
      }
      .detail-node-header .node-index {
        font-size: 11px; font-weight: 700; color: var(--vscode-textLink-foreground, #3794ff);
      }
      .detail-node-header .node-time {
        font-size: 10px; color: var(--vscode-descriptionForeground, #888);
      }

      .placeholder {
        color: var(--vscode-descriptionForeground, #666);
        font-style: italic; text-align: center; padding-top: 40px;
      }

      /* Graph rows */
      .graph-row {
        display: flex; align-items: center;
        min-height: 34px; position: relative; cursor: pointer;
        border-radius: 3px; transition: background 0.1s;
      }
      .graph-row:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
      .graph-row.selected { background: var(--vscode-list-activeSelectionBackground, #094771); }

      .graph-lanes { flex-shrink: 0; position: relative; display: flex; align-items: center; }
      .graph-label { flex: 1; padding: 6px 10px 6px 6px; min-width: 0; }

      .graph-label .prompt-text {
        font-size: 12px; line-height: 1.4;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .graph-label .meta {
        font-size: 10px; color: var(--vscode-descriptionForeground, #888); margin-top: 3px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .graph-label .meta .time { color: var(--vscode-terminal-ansiGreen, #73c991); }
      .graph-label .meta .model { color: var(--vscode-textLink-foreground, #3794ff); }
      .graph-label .meta .tools-count { color: var(--vscode-terminal-ansiCyan, #4fc3f7); }
      .graph-label .meta .files-count { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
      .graph-label .meta .subagent-count { color: var(--vscode-terminal-ansiMagenta, #bc89bd); }

      .subagent-row .graph-label .prompt-text {
        font-size: 11px; color: var(--vscode-descriptionForeground, #aaa);
      }
      .subagent-row .graph-label .meta { font-size: 9px; }

      /* Separator between prompt groups */
      .graph-row + .graph-row:not(.subagent-row) {
        margin-top: 6px;
        border-top: 1px solid var(--vscode-panel-border, #333);
        padding-top: 2px;
      }

      /* Detail panel */
      .detail-section {
        padding: 10px 12px;
        border-bottom: 1px solid var(--vscode-panel-border, #333);
      }
      .detail-section:last-child { border-bottom: none; }
      .detail-section h3 {
        font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
        color: var(--vscode-descriptionForeground, #888); margin-bottom: 8px;
        display: flex; align-items: center; gap: 8px;
      }
      .section-count {
        font-size: 9px; font-weight: 600; text-transform: none; letter-spacing: 0;
        background: var(--vscode-badge-background, #4d4d4d);
        color: var(--vscode-badge-foreground, #fff);
        padding: 1px 6px; border-radius: 8px;
      }
      .collapsible-header {
        cursor: pointer; user-select: none;
        display: flex; align-items: center; gap: 6px;
        margin: -10px -12px; padding: 10px 12px;
        border-radius: 2px;
      }
      .collapsible-header:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
      .collapsible-header .chev {
        font-size: 13px; line-height: 1; flex-shrink: 0;
        color: var(--vscode-textLink-foreground, #3794ff);
      }
      .collapsible-body { display: none; padding-top: 10px; }
      .collapsible-body.open { display: block; }
      .detail-grid {
        display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; align-items: baseline;
        font-size: 11px; background: var(--vscode-textBlockQuote-background, #252526);
        border-radius: 4px; padding: 10px 12px;
      }
      .detail-key { color: var(--vscode-descriptionForeground, #888); white-space: nowrap; }
      .detail-val { color: var(--vscode-foreground, #ccc); }
      .detail-val code {
        font-family: var(--vscode-editor-font-family, monospace);
        background: var(--vscode-editor-background, #1e1e1e);
        padding: 1px 5px; border-radius: 3px; font-size: 10px;
      }
      .detail-val .tok-in { color: var(--vscode-textLink-foreground, #3794ff); }
      .detail-val .tok-out { color: var(--vscode-terminal-ansiGreen, #73c991); }
      .detail-val .tok-cache { color: var(--vscode-terminal-ansiMagenta, #bc89bd); }
      .detail-prompt {
        font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
        padding: 10px;
        background: var(--vscode-textBlockQuote-background, #252526);
        border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
        border-radius: 3px;
      }

      .file-list { list-style: none; }
      .file-list li {
        display: flex; align-items: center; gap: 6px;
        font-size: 12px; cursor: pointer; border-radius: 3px; padding: 5px 8px;
        transition: background 0.1s;
      }
      .file-list li:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
      .file-icon { font-size: 7px; width: 14px; text-align: center; opacity: 0.5; }
      .file-name {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
      }
      .file-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s; }
      .file-list li:hover .file-actions { opacity: 1; }
      .file-actions button {
        background: none; border: none;
        color: var(--vscode-textLink-foreground, #3794ff);
        cursor: pointer; font-size: 11px; padding: 2px 4px;
      }
      .file-actions button:hover { text-decoration: underline; }

      .subagent-list { list-style: none; }
      .subagent-list li {
        padding: 6px 8px; margin-bottom: 4px;
        background: var(--vscode-textBlockQuote-background, #252526);
        border-radius: 3px; font-size: 12px; border-left: 3px solid;
      }
      .subagent-list li .sa-type {
        font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7;
      }
      .subagent-list li .sa-desc { margin-top: 2px; }
      .subagent-list li .sa-files {
        margin-top: 4px; font-size: 11px; color: var(--vscode-descriptionForeground, #888);
      }

      .badge {
        display: inline-block; font-size: 9px; padding: 1px 6px;
        border-radius: 8px; font-weight: 600;
      }
      .badge.files { background: rgba(226, 192, 141, 0.15); color: #e2c08d; }
      .badge.subagents { background: rgba(188, 137, 189, 0.15); color: #bc89bd; }

      .tool-bar-chart { display: flex; flex-direction: column; gap: 5px; }
      .tc-row { display: flex; align-items: center; gap: 8px; font-size: 11px; padding: 2px 4px; border-radius: 3px; margin: 0 -4px; }
      .tc-name { width: 68px; flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tc-track { flex: 1; height: 5px; background: var(--vscode-textBlockQuote-background, #252526); border-radius: 3px; overflow: hidden; }
      .tc-fill { height: 100%; border-radius: 3px; }
      .tc-fill.cat-file   { background: var(--vscode-textLink-foreground, #3794ff); }
      .tc-fill.cat-shell  { background: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
      .tc-fill.cat-agent  { background: var(--vscode-terminal-ansiMagenta, #bc89bd); }
      .tc-fill.cat-web    { background: var(--vscode-terminal-ansiGreen, #73c991); }
      .tc-fill.cat-other  { background: var(--vscode-terminal-ansiCyan, #4fc3f7); }
      .tc-count { width: 22px; text-align: right; flex-shrink: 0; font-size: 10px; font-weight: 600; color: var(--vscode-descriptionForeground, #888); }

      svg.graph-svg { display: block; }

      .no-data { text-align: center; padding: 60px 20px; color: var(--vscode-descriptionForeground, #666); }
      .no-data h2 { font-size: 16px; margin-bottom: 8px; }
      .no-data p { font-size: 13px; }

      .diff-badge {
        font-size: 9px; padding: 1px 4px; border-radius: 3px;
        background: var(--vscode-badge-background, #4d4d4d);
        color: var(--vscode-badge-foreground, #fff);
      }
    `;
  }

  private getScript(): string {
    return `
      const vscode = acquireVsCodeApi();

      window.onerror = function(msg, src, line, col, err) {
        document.getElementById('graph').innerHTML = '<pre style="color:red;padding:8px;">JS Error: ' + msg + '\\nLine: ' + line + ':' + col + '\\n' + (err && err.stack || '') + '</pre>';
      };

      let graph = JSON.parse(document.getElementById('graph-data').textContent || 'null');
      let sessions = JSON.parse(document.getElementById('sessions-data').textContent || '[]');
      let selectedNodeId = null;
      let statsDashboardOpen = false;

      const LANE_COLORS = [
        '#4fc3f7', '#f06292', '#81c784', '#ffb74d',
        '#ba68c8', '#e57373', '#4db6ac', '#fff176',
      ];
      const MAIN_COLOR = '#4fc3f7';
      const LANE_WIDTH = 20;
      const NODE_RADIUS = 5;
      const ROW_HEIGHT = 40;
      const SUBAGENT_ROW_HEIGHT = 34;
      const STROKE_WIDTH = 2;
      const SHADOW_WIDTH = 4;
      const SHADOW_OPACITY = 0.75;

      const BG_COLOR = getComputedStyle(document.body).backgroundColor || '#1e1e1e';

      initSessionPicker();
      renderAll();

      // Handle live data updates from extension (preserves selection state)
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'dataUpdate') {
          graph = msg.graph;
          // Update session picker if sessions changed
          if (msg.sessions) {
            sessions.length = 0;
            sessions.push(...msg.sessions);
            initSessionPicker();
          }
          renderAll();
          // Re-apply search filter if active
          const searchVal = document.getElementById('searchInput').value;
          if (searchVal) { applyFilter(searchVal); }
          // Restore detail panel for selected node
          if (selectedNodeId) {
            const selectedRow = document.querySelector('.graph-row[data-node-id="' + selectedNodeId + '"]');
            if (selectedRow) {
              selectedRow.classList.add('selected');
              showDetail(selectedNodeId, selectedRow.getAttribute('data-node-type'));
            }
          }
        }
      });

      document.getElementById('refreshBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'refresh' });
      });

      // --- Search / Filter ---
      let searchTimer = null;
      document.getElementById('searchInput').addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => applyFilter(e.target.value), 150);
      });

      function applyFilter(query) {
        const q = query.toLowerCase().trim();
        document.querySelectorAll('.graph-row').forEach(row => {
          if (!q) {
            row.classList.remove('filtered-out');
            return;
          }
          const nodeId = row.getAttribute('data-node-id');
          const nodeType = row.getAttribute('data-node-type');
          let matches = false;

          if (nodeType === 'prompt') {
            const prompt = graph.prompts.find(p => p.id === nodeId);
            if (prompt) {
              matches = prompt.prompt.toLowerCase().includes(q) ||
                prompt.fileChanges.some(f => f.filePath.toLowerCase().includes(q)) ||
                prompt.subagents.some(sa =>
                  sa.description.toLowerCase().includes(q) ||
                  sa.agentType.toLowerCase().includes(q) ||
                  sa.fileChanges.some(f => f.filePath.toLowerCase().includes(q))
                );
            }
          } else {
            const agentId = nodeId.startsWith('sa-') ? nodeId.slice(3) : nodeId;
            for (const p of graph.prompts) {
              for (const sa of p.subagents) {
                if (sa.agentId === agentId) {
                  matches = sa.description.toLowerCase().includes(q) ||
                    sa.agentType.toLowerCase().includes(q) ||
                    sa.prompt.toLowerCase().includes(q) ||
                    sa.fileChanges.some(f => f.filePath.toLowerCase().includes(q));
                }
              }
            }
          }

          row.classList.toggle('filtered-out', !matches);
        });
      }

      function initSessionPicker() {
        const picker = document.getElementById('sessionPicker');
        picker.innerHTML = '';
        for (const s of sessions) {
          const opt = document.createElement('option');
          opt.value = s.id;
          const date = new Date(s.mtime).toLocaleString();
          opt.textContent = s.id.slice(0, 8) + ' — ' + date;
          if (graph && graph.sessionId === s.id) { opt.selected = true; }
          picker.appendChild(opt);
        }
      }
      document.getElementById('sessionPicker').addEventListener('change', (e) => {
        vscode.postMessage({ type: 'switchSession', sessionId: e.target.value });
      });

      function renderAll() {
        renderStats();
        renderGraph();
        if (statsDashboardOpen) { renderStatsDashboard(); }
      }

      function renderStats() {
        const el = document.getElementById('stats-text');
        if (!graph) { el.textContent = 'No session data'; return; }
        const totalTokens = (graph.totalInputTokens || 0) + (graph.totalOutputTokens || 0);
        let html = '';
        html += pill('sp-prompts', graph.prompts.length, 'prompts');
        html += pill('sp-agents',  graph.totalSubagents || 0, 'agents');
        html += pill('sp-files',   graph.totalFileChanges, 'files');
        if (totalTokens > 0) { html += pill('sp-tokens', fmtCompact(totalTokens), 'tok'); }
        el.innerHTML = html;
        document.getElementById('stats-toggle').textContent = statsDashboardOpen ? '▴' : '▾';
      }

      const TOOL_CATEGORIES = {
        Read:'cat-file', Write:'cat-file', Edit:'cat-file', MultiEdit:'cat-file',
        Glob:'cat-file', Grep:'cat-file', NotebookEdit:'cat-file', NotebookRead:'cat-file',
        Bash:'cat-shell', Terminal:'cat-shell',
        Agent:'cat-agent', Task:'cat-agent', SubAgent:'cat-agent',
        WebSearch:'cat-web', WebFetch:'cat-web', Fetch:'cat-web',
      };
      function toolCategory(name) { return TOOL_CATEGORIES[name] || 'cat-other'; }


      function pill(cls, value, label) {
        return '<span class="stat-pill ' + cls + '"><strong>' + value + '</strong>' +
          (label ? '<span class="spl">' + label + '</span>' : '') + '</span>';
      }

      function renderStatsDashboard() {
        if (!graph) { return; }
        const el = document.getElementById('stats-dashboard-inner');

        const durationStr = graph.sessionDurationMs > 0 ? fmtDuration(graph.sessionDurationMs) : '—';
        const startStr = graph.startedAt ? new Date(graph.startedAt).toLocaleString() : '—';
        const inputTok  = graph.totalInputTokens  || 0;
        const outputTok = graph.totalOutputTokens || 0;
        const cacheRead = (graph.totalCacheReadTokens || 0) + (graph.totalCacheWriteTokens || 0);
        const totalTok  = inputTok + outputTok;
        const toolTotals = new Map();
        for (const p of graph.prompts) {
          for (const t of (p.toolsUsed || [])) {
            toolTotals.set(t.name, (toolTotals.get(t.name) || 0) + t.count);
          }
        }
        const topTools = Array.from(toolTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
        const maxToolCalls = topTools[0]?.[1] || 1;

        const fileCounts = new Map();
        for (const p of graph.prompts) {
          for (const f of (p.fileChanges || [])) { fileCounts.set(f.filePath, (fileCounts.get(f.filePath) || 0) + 1); }
          for (const sa of (p.subagents || [])) {
            for (const f of (sa.fileChanges || [])) { fileCounts.set(f.filePath, (fileCounts.get(f.filePath) || 0) + 1); }
          }
        }
        const topFiles = Array.from(fileCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

        let html = '';

        // --- Session overview ---
        html += '<div class="dash-section"><h4>Session Overview</h4>';
        html += '<div class="overview-cards">';
        html += ovCard('oc-prompts', graph.prompts.length, 'Prompts');
        html += ovCard('oc-agents',  graph.totalSubagents || 0, 'Agents');
        html += ovCard('oc-dur',     durationStr, 'Duration');
        html += ovCard('oc-files',   graph.totalFileChanges, 'Files');
        html += '</div>';
        html += '<div class="session-started">Branch: <strong>' + esc(graph.branch || 'HEAD') + '</strong> &nbsp;&middot;&nbsp; Started: ' + startStr + '</div>';
        html += '</div>';

        // --- Tokens ---
        if (totalTok > 0) {
          const models = [...new Set(graph.prompts.map(p => p.model).filter(Boolean))];
          const modelStr = models.length === 1 ? models[0] : (models.length > 1 ? models.length + ' models' : '');
          html += '<div class="dash-section"><h4>Tokens</h4>';
          html += '<div class="cost-banner">';
          html += '<div><div class="cost-amount">' + fmtNum(totalTok) + '</div><div class="cost-sublabel">total tokens</div></div>';
          html += '<div class="cost-right">';
          if (modelStr) { html += esc(modelStr); }
          html += '</div></div>';
          html += '<div class="token-row">';
          html += tokItem('tok-in',  fmtNum(inputTok),  'Input');
          html += tokItem('tok-out', fmtNum(outputTok), 'Output');
          if (cacheRead > 0) { html += tokItem('tok-cache', fmtNum(cacheRead), 'Cache'); }
          html += '</div></div>';
        }

        // --- Top tools ---
        if (topTools.length > 0) {
          html += '<div class="dash-section"><h4>Top Tools</h4><div class="tool-bar-list">';
          for (const [name, count] of topTools) {
            const pct = Math.round((count / maxToolCalls) * 100);
            html += '<div class="tool-bar-item">' +
              '<span class="tool-bar-name">' + esc(name) + '</span>' +
              '<div class="tool-bar-track"><div class="tool-bar-fill" style="width:' + pct + '%"></div></div>' +
              '<span class="tool-bar-count">' + count + '</span>' +
              '</div>';
          }
          html += '</div></div>';
        }

        // --- Most changed files ---
        if (topFiles.length > 0) {
          html += '<div class="dash-section"><h4>Most Changed Files</h4><ul class="file-stat-list">';
          for (const [fp, count] of topFiles) {
            const parts = fp.split(/[\\/]/);
            const name = parts[parts.length - 1] || fp;
            html += '<li class="file-stat-item">' +
              '<span class="file-stat-name" title="' + esc(fp) + '">' + esc(name) + '</span>' +
              '<span class="file-stat-badge">' + count + 'x</span>' +
              '</li>';
          }
          html += '</ul></div>';
        }

        el.innerHTML = html;
      }

      function ovCard(cls, value, label) {
        return '<div class="overview-card ' + cls + '"><div class="ov-value">' + value + '</div><div class="ov-label">' + label + '</div></div>';
      }
      function tokItem(cls, value, label) {
        return '<div class="token-item"><div class="tok-val ' + cls + '">' + value + '</div><div class="tok-lbl">' + label + '</div></div>';
      }
      function fmtNum(n) { return (n || 0).toLocaleString(); }
      function fmtCompact(n) {
        if (n >= 1000000) { return (n / 1000000).toFixed(1) + 'M'; }
        if (n >= 10000)   { return Math.round(n / 1000) + 'k'; }
        return fmtNum(n);
      }
      function fmtDuration(ms) {
        const s = Math.round(ms / 1000);
        if (s < 60) { return s + 's'; }
        const m = Math.round(s / 60);
        if (m < 60) { return m + 'm'; }
        const h = Math.floor(m / 60);
        return h + 'h ' + (m % 60) + 'm';
      }

      document.getElementById('stats').addEventListener('click', () => {
        statsDashboardOpen = !statsDashboardOpen;
        const dash = document.getElementById('stats-dashboard');
        dash.classList.toggle('visible', statsDashboardOpen);
        document.getElementById('stats-toggle').textContent = statsDashboardOpen ? '▴' : '▾';
        if (statsDashboardOpen) { renderStatsDashboard(); }
      });

      function renderGraph() {
        const container = document.getElementById('graph');
        if (!graph || graph.prompts.length === 0) {
          container.innerHTML = '<div class="no-data"><h2>No session data</h2><p>Open a Claude Code session or start a new one.</p></div>';
          return;
        }

        const rows = buildRows(graph);
        const maxLanes = getMaxLanes(rows);
        const svgWidth = 8 + (maxLanes + 1) * LANE_WIDTH;

        let html = '';
        for (let ri = 0; ri < rows.length; ri++) {
          const row = rows[ri];
          const rowH = row.type === 'subagent' ? SUBAGENT_ROW_HEIGHT : ROW_HEIGHT;
          const isLast = ri === rows.length - 1;
          const nextRow = !isLast ? rows[ri + 1] : null;
          const svgParts = [];

          // Main line vertical
          const hasMergeBack = row.type === 'subagent' && row.isLast;
          if (ri === 0 && row.type === 'prompt') {
            svgParts.push(svgLine(laneX(0), rowH / 2, laneX(0), rowH, MAIN_COLOR));
          } else if (!isLast) {
            svgParts.push(svgLine(laneX(0), 0, laneX(0), rowH, MAIN_COLOR));
          } else {
            // Extend trunk to full height when a merge-back curve targets the bottom
            const mainEnd = hasMergeBack ? rowH : rowH / 2;
            svgParts.push(svgLine(laneX(0), 0, laneX(0), mainEnd, MAIN_COLOR));
          }

          // Subagent lane verticals
          for (const lane of row.activeLanes) {
            if (lane.index === 0) continue;
            const x = laneX(lane.index);
            const color = LANE_COLORS[(lane.index - 1) % LANE_COLORS.length];
            // Stop at node center if this lane merges back on this row
            const isOwnLane = row.type === 'subagent' && lane.index === row.laneIndex + 1;
            const endY = (isOwnLane && row.isLast) ? rowH / 2 : rowH;
            svgParts.push(svgLine(x, 0, x, endY, color));
          }

          // Branch-off curves from prompt to subagents
          if (row.type === 'prompt' && row.data.subagents.length > 0) {
            for (const sa of row.data.subagents) {
              const fromX = laneX(0);
              const toX = laneX(sa.laneIndex + 1);
              const color = LANE_COLORS[sa.laneIndex % LANE_COLORS.length];
              const d = (rowH / 2) * 0.8;
              const pathD = 'M ' + fromX + ' ' + (rowH / 2) +
                ' C ' + fromX + ' ' + (rowH / 2 + d) +
                ', ' + toX + ' ' + (rowH - d) +
                ', ' + toX + ' ' + rowH;
              svgParts.push(
                '<path d="' + pathD + '" stroke="' + BG_COLOR + '" stroke-width="' + SHADOW_WIDTH + '" stroke-opacity="' + SHADOW_OPACITY + '" fill="none" stroke-linecap="round" />'
              );
              svgParts.push(
                '<path d="' + pathD + '" stroke="' + color + '" stroke-width="' + STROKE_WIDTH + '" fill="none" stroke-linecap="round" />'
              );
            }
          }

          // Merge-back curves for last subagent row
          if (row.type === 'subagent' && row.isLast) {
            const fromX = laneX(row.laneIndex + 1);
            const toX = laneX(0);
            const color = LANE_COLORS[row.laneIndex % LANE_COLORS.length];
            const d = (rowH / 2) * 0.8;
            const pathD = 'M ' + fromX + ' ' + (rowH / 2) +
              ' C ' + fromX + ' ' + (rowH / 2 + d) +
              ', ' + toX + ' ' + (rowH - d) +
              ', ' + toX + ' ' + rowH;
            svgParts.push(
              '<path d="' + pathD + '" stroke="' + BG_COLOR + '" stroke-width="' + SHADOW_WIDTH + '" stroke-opacity="' + SHADOW_OPACITY + '" fill="none" stroke-linecap="round" />'
            );
            svgParts.push(
              '<path d="' + pathD + '" stroke="' + color + '" stroke-width="' + STROKE_WIDTH + '" fill="none" stroke-linecap="round" />'
            );
          }

          // Node circle with outline ring
          const nodeX = row.type === 'subagent' ? laneX(row.laneIndex + 1) : laneX(0);
          const nodeColor = row.type === 'subagent'
            ? LANE_COLORS[row.laneIndex % LANE_COLORS.length]
            : MAIN_COLOR;
          svgParts.push(
            '<circle cx="' + nodeX + '" cy="' + (rowH / 2) + '" r="' + NODE_RADIUS +
            '" fill="' + nodeColor + '" stroke="' + BG_COLOR + '" stroke-width="1" stroke-opacity="0.75" />'
          );

          const svg = '<svg class="graph-svg" width="' + svgWidth + '" height="' + rowH +
            '" viewBox="0 0 ' + svgWidth + ' ' + rowH + '">' + svgParts.join('') + '</svg>';

          // Label
          let label = '';
          let rowNodeId = '';
          if (row.type === 'prompt') {
            const p = row.data;
            rowNodeId = p.id;
            const totalFiles = p.fileChanges.length + p.subagents.reduce((s, a) => s + a.fileChanges.length, 0);
            const totalTools = p.toolsUsed ? p.toolsUsed.reduce((s, t) => s + t.count, 0) : 0;
            label =
              '<div class="prompt-text">' + esc(truncate(p.prompt, 80)) + '</div>' +
              '<div class="meta">' +
                '<span class="time">' + new Date(p.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) + '</span>' +
                (totalFiles > 0 ? ' &middot; <span class="files-count">' + totalFiles + ' file' + (totalFiles !== 1 ? 's' : '') + '</span>' : '') +
                (totalTools > 0 ? ' &middot; <span class="tools-count">' + totalTools + ' tool call' + (totalTools !== 1 ? 's' : '') + '</span>' : '') +
                (p.subagents.length > 0 ? ' &middot; <span class="subagent-count">' + p.subagents.length + ' subagent' + (p.subagents.length !== 1 ? 's' : '') + '</span>' : '') +
                ' &middot; <span class="model">' + esc(p.model) + '</span>' +
              '</div>';
          } else {
            const sa = row.data;
            rowNodeId = 'sa-' + sa.agentId;
            label =
              '<div class="prompt-text">' +
                '<span class="badge subagents">' + esc(sa.agentType) + '</span> ' +
                esc(truncate(sa.description, 60)) +
              '</div>' +
              '<div class="meta">' +
                (sa.fileChanges.length > 0
                  ? '<span class="files-count">' + sa.fileChanges.length + ' file' + (sa.fileChanges.length !== 1 ? 's' : '') + '</span>'
                  : 'no file changes') +
              '</div>';
          }

          const rowClass = (row.type === 'subagent' ? 'graph-row subagent-row' : 'graph-row') +
            (selectedNodeId === rowNodeId ? ' selected' : '');

          html +=
            '<div class="' + rowClass + '" data-node-id="' + esc(rowNodeId) + '" ' +
            'data-node-type="' + row.type + '" style="height:' + rowH + 'px">' +
              '<div class="graph-lanes" style="width:' + svgWidth + 'px">' + svg + '</div>' +
              '<div class="graph-label">' + label + '</div>' +
            '</div>';
        }

        container.innerHTML = html;

        // Click handlers on rows
        container.querySelectorAll('.graph-row').forEach(el => {
          el.addEventListener('click', () => {
            const nodeId = el.getAttribute('data-node-id');
            const nodeType = el.getAttribute('data-node-type');
            selectNode(nodeId, nodeType);
          });
        });
      }

      function selectNode(nodeId, nodeType) {
        selectedNodeId = nodeId;
        // Highlight selected row
        document.querySelectorAll('.graph-row').forEach(el => {
          el.classList.toggle('selected', el.getAttribute('data-node-id') === nodeId);
        });
        // Show detail panel and resize handle
        const detailPanel = document.getElementById('detail-panel');
        const handle = document.getElementById('resize-handle');
        detailPanel.style.display = 'block';
        handle.style.display = 'block';
        // Set initial height if not yet resized
        if (!detailPanel.style.height) {
          detailPanel.style.height = '40vh';
        }
        showDetail(nodeId, nodeType);
      }

      function buildRows(graph) {
        const rows = [];
        for (const prompt of graph.prompts) {
          const activeLanes = [{ index: 0, color: MAIN_COLOR }];
          rows.push({ type: 'prompt', data: prompt, activeLanes });

          const subagents = prompt.subagents;
          for (let si = 0; si < subagents.length; si++) {
            const sa = subagents[si];
            // Include this subagent's lane plus lanes for subagents not yet rendered
            const lanes = [{ index: 0, color: MAIN_COLOR }];
            for (let sj = si; sj < subagents.length; sj++) {
              const other = subagents[sj];
              lanes.push({
                index: other.laneIndex + 1,
                color: LANE_COLORS[other.laneIndex % LANE_COLORS.length]
              });
            }
            rows.push({
              type: 'subagent', data: sa, laneIndex: sa.laneIndex, isLast: true,
              activeLanes: lanes,
            });
          }
        }
        return rows;
      }

      function getMaxLanes(rows) {
        let max = 1;
        for (const row of rows) {
          for (const lane of row.activeLanes) {
            if (lane.index + 1 > max) max = lane.index + 1;
          }
        }
        return max;
      }

      function laneX(index) { return 8 + LANE_WIDTH / 2 + index * LANE_WIDTH; }

      function svgShadow(x1, y1, x2, y2) {
        return '<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="'+BG_COLOR+'" stroke-width="'+SHADOW_WIDTH+'" stroke-opacity="'+SHADOW_OPACITY+'" stroke-linecap="round" />';
      }
      function svgLine(x1, y1, x2, y2, color) {
        return svgShadow(x1, y1, x2, y2) + '<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="'+color+'" stroke-width="'+STROKE_WIDTH+'" stroke-linecap="round" />';
      }

      // --- Detail panel ---
      function showDetail(nodeId, nodeType) {
        const panel = document.getElementById('detail-content');
        if (!graph) { panel.innerHTML = '<p class="placeholder">No data</p>'; return; }

        if (nodeType === 'subagent' || nodeId.startsWith('sa-')) {
          const agentId = nodeId.startsWith('sa-') ? nodeId.slice(3) : nodeId;
          for (const p of graph.prompts) {
            for (const sa of p.subagents) {
              if (sa.agentId === agentId) {
                panel.innerHTML = renderSubagentDetail(sa, p);
                attachFileHandlers(panel, sa.agentId, 'subagent');
                attachCopyHandlers(panel);
                return;
              }
            }
          }
        } else {
          const prompt = graph.prompts.find(p => p.id === nodeId);
          if (prompt) {
            panel.innerHTML = renderPromptDetail(prompt);
            attachFileHandlers(panel, prompt.id, 'prompt');
            attachCopyHandlers(panel);
            attachCollapsibleHandlers(panel);
            attachViewOutputHandler(panel);
            return;
          }
        }
        panel.innerHTML = '<p class="placeholder">Node not found</p>';
      }

      function renderPromptDetail(prompt) {
        let html = '';

        const idx = graph.prompts.indexOf(prompt);
        const timeStr = new Date(prompt.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        html += '<div class="detail-node-header">';
        html += '<span class="node-index">Prompt #' + (idx + 1) + '</span>';
        html += '<span class="node-time">' + timeStr + '</span>';
        html += '</div>';

        html += '<div class="detail-section"><h3><span>Prompt</span><button class="copy-btn" data-copy="' + esc(prompt.prompt) + '" title="Copy prompt">Copy</button></h3>';
        html += '<div class="detail-prompt">' + esc(prompt.prompt) + '</div></div>';

        if (prompt.response) {
          html += '<div class="detail-section"><h3>Response</h3>';
          html += '<button class="view-output-btn" data-node-id="' + esc(prompt.id) + '">View Full Output</button>';
          html += '</div>';
        }

        if (prompt.fileChanges.length > 0) {
          html += '<div class="detail-section"><h3><span>Files Changed</span><span class="section-count">' + prompt.fileChanges.length + '</span></h3>';
          html += renderFileList(prompt.fileChanges);
          html += '</div>';
        }

        if (prompt.toolsUsed && prompt.toolsUsed.length > 0) {
          const totalCalls = prompt.toolsUsed.reduce((s, t) => s + t.count, 0);
          const sorted = [...prompt.toolsUsed].sort((a, b) => b.count - a.count);
          const maxCount = sorted[0].count;
          html += '<div class="detail-section"><h3><span>Tools Used</span><span class="section-count">' + totalCalls + ' call' + (totalCalls !== 1 ? 's' : '') + '</span></h3>';
          html += '<div class="tool-bar-chart">';
          for (const t of sorted) {
            const pct = Math.round((t.count / maxCount) * 100);
            html += '<div class="tc-row">';
            html += '<span class="tc-name" title="' + esc(t.name) + '">' + esc(t.name) + '</span>';
            html += '<div class="tc-track"><div class="tc-fill ' + toolCategory(t.name) + '" style="width:' + pct + '%"></div></div>';
            html += '<span class="tc-count">' + t.count + '</span>';
            html += '</div>';
          }
          html += '</div></div>';
        }

        html += '<div class="detail-section">';
        html += '<h3 class="collapsible-header open"><span class="chev">▾</span><span>Details</span></h3>';
        html += '<div class="collapsible-body open"><div class="detail-grid">';
        html += '<span class="detail-key">Model</span><span class="detail-val"><code>' + esc(prompt.model) + '</code></span>';
        if (prompt.tokenUsage) {
          const tu = prompt.tokenUsage;
          const totalTok = (tu.inputTokens || 0) + (tu.outputTokens || 0);
          if (totalTok > 0) {
            let tokHtml = '<span class="tok-in">' + fmtNum(tu.inputTokens) + '</span> in · <span class="tok-out">' + fmtNum(tu.outputTokens) + '</span> out';
            if ((tu.cacheReadTokens || 0) > 0) { tokHtml += ' · <span class="tok-cache">' + fmtNum(tu.cacheReadTokens) + '</span> cache'; }
            html += '<span class="detail-key">Tokens</span><span class="detail-val">' + tokHtml + '</span>';
          }
        }
        html += '<span class="detail-key">Session</span><span class="detail-val"><code>' + esc(prompt.sessionId.slice(0, 8)) + '</code> <button class="copy-btn" data-copy="' + esc(prompt.sessionId) + '" title="Copy session ID">Copy</button></span>';
        html += '</div></div></div>';

        if (prompt.subagents.length > 0) {
          html += '<div class="detail-section"><h3><span>Subagents</span><span class="section-count">' + prompt.subagents.length + '</span></h3>';
          html += '<ul class="subagent-list">';
          for (const sa of prompt.subagents) {
            const color = LANE_COLORS[sa.laneIndex % LANE_COLORS.length];
            html += '<li style="border-left-color:' + color + '">';
            html += '<div class="sa-type">' + esc(sa.agentType) + '</div>';
            html += '<div class="sa-desc">' + esc(sa.description) + '</div>';
            if (sa.fileChanges.length > 0) {
              html += '<div class="sa-files">' + sa.fileChanges.length + ' file(s) changed</div>';
            }
            html += '</li>';
          }
          html += '</ul></div>';
        }

        return html;
      }

      function renderSubagentDetail(sa, parentPrompt) {
        const color = LANE_COLORS[sa.laneIndex % LANE_COLORS.length];
        let html = '';

        html += '<div class="detail-section"><h3>Subagent</h3>';
        html += '<div style="border-left:3px solid ' + color + ';padding-left:10px">';
        html += '<div class="detail-meta">';
        html += 'Type: <code>' + esc(sa.agentType) + '</code><br>';
        html += 'Description: ' + esc(sa.description) + '<br>';
        html += 'Agent ID: <code>' + esc(sa.agentId.slice(0, 12)) + '</code> <button class="copy-btn" data-copy="' + esc(sa.agentId) + '" title="Copy agent ID">Copy</button>';
        html += '</div></div></div>';

        html += '<div class="detail-section"><h3>Agent Prompt <button class="copy-btn" data-copy="' + esc(sa.prompt) + '" title="Copy prompt">Copy</button></h3>';
        html += '<div class="detail-prompt">' + esc(truncate(sa.prompt, 500)) + '</div></div>';

        html += '<div class="detail-section"><h3>Parent Prompt</h3>';
        html += '<div class="detail-prompt" style="border-left-color:' + MAIN_COLOR + '">' +
          esc(truncate(parentPrompt.prompt, 200)) + '</div></div>';

        if (sa.fileChanges.length > 0) {
          html += '<div class="detail-section"><h3>Files Changed (' + sa.fileChanges.length + ')</h3>';
          html += renderFileList(sa.fileChanges);
          html += '</div>';
        }

        return html;
      }

      function renderFileList(files) {
        let html = '<ul class="file-list">';
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const parts = f.filePath.split(/[\\/]/);
          const name = parts.pop() || f.filePath;
          const dir = parts.length > 0 ? parts[parts.length - 1] : '';
          html += '<li data-file-index="' + i + '" data-file-path="' + esc(f.filePath) + '">';
          html += '<span class="file-icon">●</span>';
          html += '<span class="file-name" title="' + esc(f.filePath) + '">';
          if (dir) html += '<span style="opacity:0.5">' + esc(dir) + '/</span>';
          html += esc(name);
          html += '</span>';
          html += '<span class="file-actions">';
          html += '<button class="open-btn" title="Open file">Open</button>';
          if (f.hasDiff) {
            html += '<button class="diff-btn" title="Show changes from this prompt">Diff</button>';
          }
          html += '</span>';
          html += '</li>';
        }
        html += '</ul>';
        return html;
      }

      function attachFileHandlers(container, nodeId, nodeType) {
        container.querySelectorAll('.file-list li').forEach(li => {
          const filePath = li.getAttribute('data-file-path');
          const fileIndex = parseInt(li.getAttribute('data-file-index'), 10);

          // Clicking the row shows the diff (primary action)
          li.addEventListener('click', () => {
            const diffBtn = li.querySelector('.diff-btn');
            if (diffBtn) {
              vscode.postMessage({ type: 'showDiff', nodeId, nodeType, fileIndex });
            } else {
              vscode.postMessage({ type: 'openFile', filePath });
            }
          });

          li.querySelector('.open-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'openFile', filePath });
          });
          li.querySelector('.diff-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'showDiff', nodeId, nodeType, fileIndex });
          });
        });
      }

      // --- Resize handle ---
      (function initResize() {
        const handle = document.getElementById('resize-handle');
        const detailPanel = document.getElementById('detail-panel');
        const container = document.getElementById('graph-container');
        let startY = 0;
        let startHeight = 0;

        handle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          startY = e.clientY;
          startHeight = detailPanel.offsetHeight;
          handle.classList.add('dragging');
          document.addEventListener('mousemove', onDrag);
          document.addEventListener('mouseup', onStop);
        });

        function onDrag(e) {
          const delta = startY - e.clientY;
          const containerH = container.offsetHeight;
          const newHeight = Math.max(60, Math.min(containerH - 80, startHeight + delta));
          detailPanel.style.height = newHeight + 'px';
        }

        function onStop() {
          handle.classList.remove('dragging');
          document.removeEventListener('mousemove', onDrag);
          document.removeEventListener('mouseup', onStop);
        }
      })();

      // --- Copy to clipboard ---
      function copyText(text, btn) {
        navigator.clipboard.writeText(text).then(() => {
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
        });
      }

      function attachCopyHandlers(container) {
        container.querySelectorAll('.copy-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyText(btn.getAttribute('data-copy'), btn);
          });
        });
      }

      function attachCollapsibleHandlers(container) {
        container.querySelectorAll('.collapsible-header').forEach(header => {
          header.addEventListener('click', () => {
            const isOpen = header.classList.toggle('open');
            const chev = header.querySelector('.chev');
            if (chev) { chev.textContent = isOpen ? '▾' : '▸'; }
            const body = header.nextElementSibling;
            if (body && body.classList.contains('collapsible-body')) {
              body.classList.toggle('open', isOpen);
            }
          });
        });
      }

      function attachViewOutputHandler(container) {
        container.querySelector('.view-output-btn')?.addEventListener('click', (e) => {
          const nodeId = e.target.getAttribute('data-node-id');
          vscode.postMessage({ type: 'viewOutput', nodeId });
        });
      }

      // --- Utilities ---
      function esc(str) {
        if (!str) return '';
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
      }
      function truncate(str, maxLen) {
        if (!str) return '';
        return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
      }
    `;
  }

  dispose(): void {
    this.sidebarView = null;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
