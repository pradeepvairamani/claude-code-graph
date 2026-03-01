import * as vscode from 'vscode';
import { MetadataReader } from '../metadata/reader';
import type { IntelSession, SessionEntry, IntelCommit } from '../metadata/types';

type GroupMode = 'agent' | 'session' | 'branch';

/**
 * Tree item types for the sidebar view.
 */
type IntelTreeNode =
  | { kind: 'group'; label: string; children: IntelTreeNode[] }
  | { kind: 'entry'; entry: SessionEntry; session: IntelSession }
  | { kind: 'commit'; commit: IntelCommit; session: IntelSession };

/**
 * Provides a tree view for the Claude Git Intel sidebar.
 */
export class IntelTreeProvider
  implements vscode.TreeDataProvider<IntelTreeNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    IntelTreeNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly reader: MetadataReader,
    private readonly mode: GroupMode
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: IntelTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'group': {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.contextValue = 'group';
        return item;
      }
      case 'entry': {
        const prompt = truncate(element.entry.prompt, 50);
        const commitCount = element.entry.commits.length;
        const label = `"${prompt}" \u2192 ${commitCount} commit${commitCount !== 1 ? 's' : ''}`;
        const item = new vscode.TreeItem(
          label,
          commitCount > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        item.tooltip = element.entry.prompt;
        item.contextValue = 'entry';
        return item;
      }
      case 'commit': {
        const label = `${element.commit.sha} \u2014 ${element.commit.message}`;
        const item = new vscode.TreeItem(
          label,
          vscode.TreeItemCollapsibleState.None
        );
        item.contextValue = 'commit';
        item.tooltip = `${element.commit.message}\n\nFiles: ${element.commit.filesChanged.map((f) => f.path).join(', ')}`;
        return item;
      }
    }
  }

  getChildren(element?: IntelTreeNode): IntelTreeNode[] {
    if (!element) {
      return this.buildRootNodes();
    }

    switch (element.kind) {
      case 'group':
        return element.children;
      case 'entry':
        return element.entry.commits.map((commit) => ({
          kind: 'commit' as const,
          commit,
          session: element.session,
        }));
      case 'commit':
        return [];
    }
  }

  private buildRootNodes(): IntelTreeNode[] {
    if (!this.reader.exists()) {
      return [];
    }

    const sessions = this.reader.readAllSessions();

    switch (this.mode) {
      case 'agent':
        return this.groupByAgent(sessions);
      case 'session':
        return this.groupBySession(sessions);
      case 'branch':
        return this.groupByBranch(sessions);
    }
  }

  private groupByAgent(sessions: IntelSession[]): IntelTreeNode[] {
    const agentMap = new Map<string, IntelTreeNode[]>();

    for (const session of sessions) {
      const agent = session.agent;
      if (!agentMap.has(agent)) {
        agentMap.set(agent, []);
      }
      for (const entry of session.entries) {
        agentMap.get(agent)!.push({
          kind: 'entry',
          entry,
          session,
        });
      }
    }

    return Array.from(agentMap.entries()).map(([agent, children]) => {
      const commitCount = children.reduce(
        (acc, c) => acc + (c.kind === 'entry' ? c.entry.commits.length : 0),
        0
      );
      return {
        kind: 'group' as const,
        label: `${agent} (${commitCount} commits)`,
        children,
      };
    });
  }

  private groupBySession(sessions: IntelSession[]): IntelTreeNode[] {
    return sessions.map((session) => {
      const date = new Date(session.startedAt).toLocaleString();
      const children: IntelTreeNode[] = session.entries.map((entry) => ({
        kind: 'entry' as const,
        entry,
        session,
      }));

      return {
        kind: 'group' as const,
        label: `Session ${session.sessionId.slice(0, 8)} (${date})`,
        children,
      };
    });
  }

  private groupByBranch(sessions: IntelSession[]): IntelTreeNode[] {
    const branchMap = new Map<string, IntelTreeNode[]>();

    for (const session of sessions) {
      const branch = session.branch;
      if (!branchMap.has(branch)) {
        branchMap.set(branch, []);
      }
      for (const entry of session.entries) {
        branchMap.get(branch)!.push({
          kind: 'entry',
          entry,
          session,
        });
      }
    }

    return Array.from(branchMap.entries()).map(([branch, children]) => {
      const commitCount = children.reduce(
        (acc, c) => acc + (c.kind === 'entry' ? c.entry.commits.length : 0),
        0
      );
      return {
        kind: 'group' as const,
        label: `${branch} (${commitCount} AI commits)`,
        children,
      };
    });
  }
}

function truncate(text: string, maxLen: number): string {
  const singleLine = text.replace(/\n/g, ' ').trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return singleLine.slice(0, maxLen - 1) + '\u2026';
}
