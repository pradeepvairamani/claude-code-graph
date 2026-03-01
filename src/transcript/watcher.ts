import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { TranscriptParser } from './parser';
import type { SessionGraph } from './types';

/**
 * Watches Claude Code JSONL transcript files for changes
 * and emits parsed SessionGraph updates.
 */
export class TranscriptWatcher extends EventEmitter {
  private fsWatcher: fs.FSWatcher | null = null;
  private fileWatchers = new Map<string, fs.FSWatcher>();
  private parser = new TranscriptParser();
  private lastSizes = new Map<string, number>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly debounceMs = 500;

  constructor(private readonly projectDir: string) {
    super();
  }

  /**
   * Start watching the project directory for JSONL transcript changes.
   */
  start(): void {
    if (!fs.existsSync(this.projectDir)) {
      return;
    }

    // Watch the project directory for new session files
    try {
      this.fsWatcher = fs.watch(this.projectDir, (eventType, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          this.scheduleReparse(path.join(this.projectDir, filename));
        }
      });
    } catch {
      // Directory might not be watchable
    }

    // Also watch existing JSONL files directly for modifications
    this.watchExistingFiles();
  }

  /**
   * Watch all existing JSONL files in the project directory.
   */
  private watchExistingFiles(): void {
    try {
      const files = fs.readdirSync(this.projectDir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          this.watchFile(path.join(this.projectDir, file));
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  /**
   * Watch a specific JSONL file for modifications.
   */
  private watchFile(filePath: string): void {
    if (this.fileWatchers.has(filePath)) { return; }

    try {
      const watcher = fs.watch(filePath, () => {
        this.scheduleReparse(filePath);
      });
      this.fileWatchers.set(filePath, watcher);
    } catch {
      // File might not be watchable
    }
  }

  /**
   * Schedule a debounced reparse of a transcript file.
   */
  private scheduleReparse(filePath: string): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.reparseFile(filePath);
    }, this.debounceMs);
  }

  /**
   * Parse (or re-parse) a transcript file and emit the update.
   */
  private reparseFile(filePath: string): void {
    if (!fs.existsSync(filePath)) { return; }

    // Check if file has actually changed
    try {
      const stat = fs.statSync(filePath);
      const lastSize = this.lastSizes.get(filePath) || 0;
      if (stat.size === lastSize) { return; }
      this.lastSizes.set(filePath, stat.size);
    } catch {
      return;
    }

    const graph = this.parser.parseSession(filePath);
    if (graph) {
      this.emit('update', graph, filePath);
    }
  }

  /**
   * Get all available session files in the project directory.
   */
  getSessionFiles(): Array<{ path: string; sessionId: string; mtime: Date }> {
    if (!fs.existsSync(this.projectDir)) { return []; }

    try {
      const files = fs.readdirSync(this.projectDir);
      return files
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fullPath = path.join(this.projectDir, f);
          const stat = fs.statSync(fullPath);
          return {
            path: fullPath,
            sessionId: f.replace('.jsonl', ''),
            mtime: stat.mtime,
          };
        })
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    } catch {
      return [];
    }
  }

  /**
   * Parse a specific session by ID.
   */
  parseSessionById(sessionId: string): SessionGraph | null {
    const filePath = path.join(this.projectDir, `${sessionId}.jsonl`);
    return this.parser.parseSession(filePath);
  }

  /**
   * Parse the most recent session.
   */
  parseMostRecentSession(): SessionGraph | null {
    const sessions = this.getSessionFiles();
    if (sessions.length === 0) { return null; }
    return this.parser.parseSession(sessions[0].path);
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    for (const watcher of this.fileWatchers.values()) {
      watcher.close();
    }
    this.fileWatchers.clear();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
