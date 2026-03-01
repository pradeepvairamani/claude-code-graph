import type { PromptInfo, BlameLine } from './types';
import { MetadataReader } from './reader';

/**
 * Builds a mapping from (filePath, lineNumber) → PromptInfo
 * by cross-referencing git blame output with the intel index.
 */
export class LineIndexer {
  constructor(private readonly reader: MetadataReader) {}

  /**
   * Given blame data for a file, resolve which lines were AI-authored
   * and return a map of lineNumber → PromptInfo.
   */
  resolveLines(blameLines: BlameLine[]): Map<number, PromptInfo> {
    const result = new Map<number, PromptInfo>();
    const index = this.reader.readIndex();

    // Group blame lines by commit SHA to avoid redundant lookups
    const shaToLines = new Map<string, number[]>();
    for (const bl of blameLines) {
      const existing = shaToLines.get(bl.sha);
      if (existing) {
        existing.push(bl.lineNumber);
      } else {
        shaToLines.set(bl.sha, [bl.lineNumber]);
      }
    }

    for (const [sha, lineNumbers] of shaToLines) {
      // Check both full SHA and 7-char short SHA in the index
      const indexEntry = index[sha] || index[sha.slice(0, 7)];
      if (!indexEntry) {
        continue;
      }

      const session = this.reader.readSession(indexEntry.sessionFile);
      if (!session) {
        continue;
      }

      const entry = session.entries[indexEntry.entryIndex];
      if (!entry) {
        continue;
      }

      // Find the matching commit within the entry
      const commit = entry.commits.find(
        (c) => c.sha === sha || c.sha === sha.slice(0, 7) || sha.startsWith(c.sha)
      );

      const promptInfo: PromptInfo = {
        prompt: entry.prompt,
        promptHash: entry.promptHash,
        agent: session.agent,
        sessionId: session.sessionId,
        commitSha: commit?.sha || sha.slice(0, 7),
        commitMessage: commit?.message || '',
        timestamp: entry.timestamp,
        branch: session.branch,
      };

      for (const lineNum of lineNumbers) {
        result.set(lineNum, promptInfo);
      }
    }

    return result;
  }
}
