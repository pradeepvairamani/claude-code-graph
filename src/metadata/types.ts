/** A single file changed in a commit */
export interface FileChange {
  path: string;
  linesAdded: number[];
  linesDeleted: number[];
}

/** A commit captured by the intel system */
export interface IntelCommit {
  sha: string;
  message: string;
  filesChanged: FileChange[];
}

/** A single prompt→commit(s) entry within a session */
export interface SessionEntry {
  prompt: string;
  promptHash: string;
  timestamp: string;
  commits: IntelCommit[];
}

/** A full Claude Code session record */
export interface IntelSession {
  sessionId: string;
  agent: string;
  branch: string;
  startedAt: string;
  entries: SessionEntry[];
}

/** index.json mapping: commit SHA → session file reference */
export interface IndexEntry {
  sessionFile: string;
  entryIndex: number;
}

export interface IntelIndex {
  [commitSha: string]: IndexEntry;
}

/** Resolved prompt info for a specific line in a file */
export interface PromptInfo {
  prompt: string;
  promptHash: string;
  agent: string;
  sessionId: string;
  commitSha: string;
  commitMessage: string;
  timestamp: string;
  branch: string;
}

/** Git blame output for a single line */
export interface BlameLine {
  sha: string;
  lineNumber: number;
  originalLineNumber: number;
  author: string;
  authorTime: number;
  summary: string;
}
