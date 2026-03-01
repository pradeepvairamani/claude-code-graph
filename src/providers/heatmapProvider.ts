import * as vscode from 'vscode';
import * as path from 'path';
import { MetadataReader } from '../metadata/reader';

/**
 * Provides file decorations in the Explorer showing AI contribution percentage.
 * Color scale: blue (0% AI) → purple (50%) → red (100% AI).
 */
export class HeatmapDecorationProvider
  implements vscode.FileDecorationProvider
{
  private _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  // Cache of file path → AI percentage (0-100)
  private aiPercentageCache = new Map<string, number>();

  constructor(
    private readonly reader: MetadataReader,
    private readonly repoRoot: string
  ) {
    this.buildCache();
  }

  /**
   * Rebuild the percentage cache from metadata.
   */
  buildCache(): void {
    this.aiPercentageCache.clear();

    if (!this.reader.exists()) {
      return;
    }

    // Count AI-authored lines per file across all sessions
    const fileTotalLines = new Map<string, number>();
    const fileAiLines = new Map<string, number>();

    const sessions = this.reader.readAllSessions();
    for (const session of sessions) {
      for (const entry of session.entries) {
        for (const commit of entry.commits) {
          for (const fc of commit.filesChanged) {
            const current = fileAiLines.get(fc.path) || 0;
            fileAiLines.set(fc.path, current + fc.linesAdded.length);

            const total = fileTotalLines.get(fc.path) || 0;
            fileTotalLines.set(fc.path, total + fc.linesAdded.length);
          }
        }
      }
    }

    for (const [filePath, aiLines] of fileAiLines) {
      const total = fileTotalLines.get(filePath) || aiLines;
      const pct = total > 0 ? Math.round((aiLines / total) * 100) : 0;
      this.aiPercentageCache.set(filePath, pct);
    }

    this._onDidChangeFileDecorations.fire(undefined);
  }

  provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== 'file') {
      return undefined;
    }

    const relativePath = path.relative(this.repoRoot, uri.fsPath);
    if (relativePath.startsWith('..')) {
      return undefined;
    }

    // Normalize path separators
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const pct = this.aiPercentageCache.get(normalizedPath);

    if (pct === undefined || pct === 0) {
      return undefined;
    }

    return {
      badge: `${pct}%`,
      tooltip: `AI contribution: ${pct}%`,
      color: this.getColor(pct),
    };
  }

  /**
   * Map percentage to a color on the blue→purple→red scale.
   */
  private getColor(pct: number): vscode.ThemeColor {
    if (pct >= 80) {
      return new vscode.ThemeColor('charts.red');
    } else if (pct >= 50) {
      return new vscode.ThemeColor('charts.purple');
    } else if (pct >= 20) {
      return new vscode.ThemeColor('charts.blue');
    }
    return new vscode.ThemeColor('charts.blue');
  }

  refresh(): void {
    this.buildCache();
  }
}
