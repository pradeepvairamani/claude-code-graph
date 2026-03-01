import * as fs from 'fs';
import * as path from 'path';
import type { IntelSession, IntelIndex } from './types';

/**
 * Reads and caches .claude/intel/ metadata files.
 */
export class MetadataReader {
  private sessionsCache = new Map<string, IntelSession>();
  private indexCache: IntelIndex | null = null;
  private lastIndexMtime = 0;

  constructor(private readonly intelDir: string) {}

  /**
   * Check if the intel directory exists.
   */
  exists(): boolean {
    return fs.existsSync(this.intelDir);
  }

  /**
   * Read and cache the index.json file.
   * Re-reads from disk if the file has been modified since last read.
   */
  readIndex(): IntelIndex {
    const indexPath = path.join(this.intelDir, 'index.json');

    if (!fs.existsSync(indexPath)) {
      return {};
    }

    const stat = fs.statSync(indexPath);
    const mtime = stat.mtimeMs;

    if (this.indexCache && mtime <= this.lastIndexMtime) {
      return this.indexCache;
    }

    const raw = fs.readFileSync(indexPath, 'utf-8');
    this.indexCache = JSON.parse(raw) as IntelIndex;
    this.lastIndexMtime = mtime;
    return this.indexCache;
  }

  /**
   * Read a session file by filename.
   */
  readSession(sessionFile: string): IntelSession | null {
    if (this.sessionsCache.has(sessionFile)) {
      return this.sessionsCache.get(sessionFile)!;
    }

    const sessionPath = path.join(this.intelDir, 'sessions', sessionFile);
    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    const raw = fs.readFileSync(sessionPath, 'utf-8');
    const session = JSON.parse(raw) as IntelSession;
    this.sessionsCache.set(sessionFile, session);
    return session;
  }

  /**
   * Read all session files in the sessions directory.
   */
  readAllSessions(): IntelSession[] {
    const sessionsDir = path.join(this.intelDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
    const sessions: IntelSession[] = [];

    for (const file of files) {
      const session = this.readSession(file);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  /**
   * Clear all caches, forcing re-read from disk on next access.
   */
  clearCache(): void {
    this.sessionsCache.clear();
    this.indexCache = null;
    this.lastIndexMtime = 0;
  }
}
