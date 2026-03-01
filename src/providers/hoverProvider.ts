import * as vscode from 'vscode';
import type { BlameProvider } from './blameProvider';

/**
 * Provides rich hover tooltips on AI-authored lines.
 * This supplements the decoration hover with a full HoverProvider
 * so that hovers work even when the cursor isn't directly on the annotation.
 */
export class IntelHoverProvider implements vscode.HoverProvider {
  constructor(private readonly blameProvider: BlameProvider) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    const info = this.blameProvider.getPromptInfoForLine(
      document.uri,
      position.line
    );

    if (!info) {
      return null;
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    md.appendMarkdown(`### Claude Git Intel\n\n`);
    md.appendMarkdown(`| | |\n|---|---|\n`);
    md.appendMarkdown(`| **Prompt** | ${escapeMarkdown(info.prompt)} |\n`);
    md.appendMarkdown(`| **Agent** | \`${info.agent}\` |\n`);
    md.appendMarkdown(
      `| **Commit** | \`${info.commitSha}\` — ${escapeMarkdown(info.commitMessage)} |\n`
    );
    md.appendMarkdown(`| **Branch** | \`${info.branch}\` |\n`);
    md.appendMarkdown(
      `| **Time** | ${new Date(info.timestamp).toLocaleString()} |\n`
    );
    md.appendMarkdown(`| **Session** | \`${info.sessionId}\` |\n`);

    md.appendMarkdown(`\n---\n`);
    md.appendMarkdown(
      `[Show Prompt Detail](command:claudeIntel.showPromptDetail?${encodeURIComponent(JSON.stringify({ sha: info.commitSha }))})`
    );

    return new vscode.Hover(md, document.lineAt(position.line).range);
  }
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .trim();
}
