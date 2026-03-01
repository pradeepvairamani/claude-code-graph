import * as vscode from 'vscode';
import * as path from 'path';
import { MetadataReader } from '../metadata/reader';
import { LineIndexer } from '../metadata/indexer';
import { blame } from '../utils/git';
import { getConfig } from '../utils/config';
import type { PromptInfo } from '../metadata/types';

/**
 * Provides inline "ghost text" annotations on AI-authored lines,
 * similar to GitLens blame annotations.
 */
export class BlameProvider implements vscode.Disposable {
  private decorationType: vscode.TextEditorDecorationType;
  private heatmapDecorationType: vscode.TextEditorDecorationType;
  private enabled: boolean;
  private heatmapEnabled: boolean;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposables: vscode.Disposable[] = [];

  // Cache: file URI string → Map<lineNumber, PromptInfo>
  private lineCache = new Map<string, Map<number, PromptInfo>>();

  constructor(
    private readonly reader: MetadataReader,
    private readonly indexer: LineIndexer,
    private readonly repoRoot: string
  ) {
    const config = getConfig();
    this.enabled = config.blameEnabled;
    this.heatmapEnabled = config.heatmapEnabled;

    this.decorationType = this.createDecorationType(config.annotationColor);
    this.heatmapDecorationType = this.createHeatmapDecorationType();

    // Listen for editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.scheduleUpdate(editor);
        }
      })
    );

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && e.document === editor.document) {
          // Invalidate cache for this file since content changed
          this.lineCache.delete(e.document.uri.toString());
          this.scheduleUpdate(editor);
        }
      })
    );

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        // Re-blame after save since git state may have changed
        this.lineCache.delete(doc.uri.toString());
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === doc) {
          this.scheduleUpdate(editor);
        }
      })
    );

    // Initial decoration for active editor
    if (vscode.window.activeTextEditor) {
      this.scheduleUpdate(vscode.window.activeTextEditor);
    }
  }

  private createDecorationType(
    color: string
  ): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      after: {
        color: color,
        fontStyle: 'italic',
        margin: '0 0 0 3em',
      },
      isWholeLine: true,
    });
  }

  private createHeatmapDecorationType(): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
    });
  }

  /**
   * Debounced update to avoid rapid-fire decoration changes.
   */
  private scheduleUpdate(editor: vscode.TextEditor): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    const delay = getConfig().debounceMs;
    this.debounceTimer = setTimeout(() => {
      this.updateDecorations(editor).catch((err) => {
        console.error('[Claude Intel] Failed to update decorations:', err);
      });
    }, delay);
  }

  /**
   * Core logic: run git blame, cross-reference with intel index,
   * and apply decorations to AI-authored lines.
   */
  private async updateDecorations(
    editor: vscode.TextEditor
  ): Promise<void> {
    if (!this.enabled && !this.heatmapEnabled) {
      editor.setDecorations(this.decorationType, []);
      editor.setDecorations(this.heatmapDecorationType, []);
      return;
    }

    const doc = editor.document;

    // Only process file scheme documents
    if (doc.uri.scheme !== 'file') {
      return;
    }

    // Check if intel data exists
    if (!this.reader.exists()) {
      return;
    }

    const filePath = doc.uri.fsPath;
    const relativePath = path.relative(this.repoRoot, filePath);

    // Skip files outside the repo
    if (relativePath.startsWith('..')) {
      return;
    }

    try {
      let lineMap = this.lineCache.get(doc.uri.toString());

      if (!lineMap) {
        // Run git blame
        const blameLines = await blame(relativePath, this.repoRoot);

        // Cross-reference with intel index
        lineMap = this.indexer.resolveLines(blameLines);
        this.lineCache.set(doc.uri.toString(), lineMap);
      }

      // Build decorations
      const blameDecorations: vscode.DecorationOptions[] = [];
      const heatmapDecorations: vscode.DecorationOptions[] = [];

      for (const [lineNum, info] of lineMap) {
        // VS Code lines are 0-indexed, git blame is 1-indexed
        const line = lineNum - 1;
        if (line < 0 || line >= doc.lineCount) {
          continue;
        }

        const range = doc.lineAt(line).range;

        if (this.enabled) {
          const truncatedPrompt = truncate(info.prompt, 60);
          blameDecorations.push({
            range,
            renderOptions: {
              after: {
                contentText: `  AI \u00b7 ${truncatedPrompt}`,
              },
            },
            hoverMessage: this.buildHoverMessage(info),
          });
        }

        if (this.heatmapEnabled) {
          heatmapDecorations.push({
            range,
            renderOptions: {
              before: {
                contentText: '\u2588',
                color: '#a855f7',
                margin: '0 4px 0 0',
              },
            },
          });
        }
      }

      editor.setDecorations(this.decorationType, blameDecorations);
      editor.setDecorations(this.heatmapDecorationType, heatmapDecorations);
    } catch (err) {
      // Silently fail for files not tracked by git
      console.debug('[Claude Intel] Blame failed for', relativePath, err);
    }
  }

  /**
   * Build a rich Markdown hover message for an AI-authored line.
   */
  private buildHoverMessage(info: PromptInfo): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    md.appendMarkdown(`**Claude Git Intel**\n\n`);
    md.appendMarkdown(`**Prompt:** ${info.prompt}\n\n`);
    md.appendMarkdown(`**Agent:** \`${info.agent}\`\n\n`);
    md.appendMarkdown(`**Commit:** \`${info.commitSha}\` — ${info.commitMessage}\n\n`);
    md.appendMarkdown(`**Branch:** \`${info.branch}\`\n\n`);
    md.appendMarkdown(
      `**Time:** ${new Date(info.timestamp).toLocaleString()}\n\n`
    );
    md.appendMarkdown(
      `**Session:** \`${info.sessionId}\`\n\n`
    );
    md.appendMarkdown(
      `---\n*Hash: \`${info.promptHash}\`*`
    );

    return md;
  }

  /**
   * Toggle blame annotations on/off.
   */
  toggle(): void {
    this.enabled = !this.enabled;
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      if (!this.enabled) {
        editor.setDecorations(this.decorationType, []);
      } else {
        this.lineCache.clear();
        this.scheduleUpdate(editor);
      }
    }
  }

  /**
   * Toggle heatmap on/off.
   */
  toggleHeatmap(): void {
    this.heatmapEnabled = !this.heatmapEnabled;
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      if (!this.heatmapEnabled) {
        editor.setDecorations(this.heatmapDecorationType, []);
      } else {
        this.scheduleUpdate(editor);
      }
    }
  }

  /**
   * Get the PromptInfo for a specific line in the active editor.
   */
  getPromptInfoForLine(
    uri: vscode.Uri,
    lineNumber: number
  ): PromptInfo | undefined {
    const lineMap = this.lineCache.get(uri.toString());
    if (!lineMap) {
      return undefined;
    }
    // Convert 0-indexed VS Code line to 1-indexed git line
    return lineMap.get(lineNumber + 1);
  }

  /**
   * Clear the line cache and refresh.
   */
  refresh(): void {
    this.lineCache.clear();
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this.scheduleUpdate(editor);
    }
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.decorationType.dispose();
    this.heatmapDecorationType.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function truncate(text: string, maxLen: number): string {
  const singleLine = text.replace(/\n/g, ' ').trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return singleLine.slice(0, maxLen - 1) + '\u2026';
}
