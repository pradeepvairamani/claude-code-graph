import * as vscode from 'vscode';

const SECTION = 'claudeIntel';

export function getConfig() {
  const config = vscode.workspace.getConfiguration(SECTION);

  return {
    get enabled(): boolean {
      return config.get<boolean>('enabled', true);
    },
    get blameEnabled(): boolean {
      return config.get<boolean>('blameEnabled', true);
    },
    get heatmapEnabled(): boolean {
      return config.get<boolean>('heatmapEnabled', false);
    },
    get intelDirectory(): string {
      return config.get<string>('intelDirectory', '.claude/intel');
    },
    get annotationColor(): string {
      return config.get<string>('annotationColor', '#6b7280');
    },
    get debounceMs(): number {
      return config.get<number>('debounceMs', 300);
    },
  };
}

export function onConfigChange(
  callback: () => void
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      callback();
    }
  });
}
