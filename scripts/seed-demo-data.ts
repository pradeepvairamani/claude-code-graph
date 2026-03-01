#!/usr/bin/env npx tsx
/**
 * Seed Demo Data — Generates realistic .claude/intel/ metadata
 * from an existing repo's git history.
 *
 * Usage:
 *   npx tsx scripts/seed-demo-data.ts [repo-path]
 *
 * Defaults to current directory if no repo path given.
 * Marks commits with "Co-Authored-By: Claude" as AI-authored.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface FileChange {
  path: string;
  linesAdded: number[];
  linesDeleted: number[];
}

interface Commit {
  sha: string;
  message: string;
  filesChanged: FileChange[];
}

interface Entry {
  prompt: string;
  promptHash: string;
  timestamp: string;
  commits: Commit[];
}

interface Session {
  sessionId: string;
  agent: string;
  branch: string;
  startedAt: string;
  entries: Entry[];
}

interface IndexEntry {
  sessionFile: string;
  entryIndex: number;
}

const AGENTS = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

const SAMPLE_PROMPTS = [
  'Add user authentication with JWT',
  'Fix the login redirect bug',
  'Refactor the database connection pool',
  'Add input validation to the API endpoints',
  'Create unit tests for the auth module',
  'Implement dark mode toggle',
  'Add error handling for network failures',
  'Update the README with setup instructions',
  'Optimize the search query performance',
  'Add pagination to the list endpoints',
  'Fix CSS layout issues on mobile',
  'Implement rate limiting middleware',
  'Add logging and monitoring hooks',
  'Create the settings page UI',
  'Fix memory leak in websocket handler',
];

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8' }).trim();
}

function main() {
  const repoPath = process.argv[2] || process.cwd();

  // Verify it's a git repo
  try {
    git('rev-parse --is-inside-work-tree', repoPath);
  } catch {
    console.error(`Error: ${repoPath} is not a git repository`);
    process.exit(1);
  }

  const repoRoot = git('rev-parse --show-toplevel', repoPath);
  const intelDir = path.join(repoRoot, '.claude', 'intel');
  const sessionsDir = path.join(intelDir, 'sessions');

  // Clean existing intel data
  if (fs.existsSync(intelDir)) {
    fs.rmSync(intelDir, { recursive: true });
  }
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Get commit log
  const logOutput = git(
    'log --format="%H|%h|%s|%aI|%an|%D" --no-merges -50',
    repoRoot
  );

  if (!logOutput) {
    console.error('No commits found in repository');
    process.exit(1);
  }

  const commits = logOutput.split('\n').map((line) => {
    const [fullSha, shortSha, message, date, author, refs] = line.split('|');
    return { fullSha, shortSha, message, date, author, refs: refs || '' };
  });

  // Determine which commits are "AI-authored"
  // Strategy: commits with "Co-Authored-By: Claude" OR every 2nd-3rd commit
  const aiCommits = commits.filter((c, i) => {
    const hasCoAuthor =
      c.message.toLowerCase().includes('co-authored-by: claude') ||
      c.author.toLowerCase().includes('claude');
    return hasCoAuthor || i % 3 === 0 || i % 3 === 1;
  });

  if (aiCommits.length === 0) {
    console.log('No AI commits identified. Marking alternating commits as AI-authored for demo.');
  }

  // Group into sessions (3-5 commits per session)
  const sessions: Session[] = [];
  const index: Record<string, IndexEntry> = {};

  let sessionIdx = 0;
  for (let i = 0; i < aiCommits.length; i += Math.floor(Math.random() * 3) + 2) {
    const sessionCommits = aiCommits.slice(i, i + Math.floor(Math.random() * 3) + 2);
    if (sessionCommits.length === 0) break;

    const sessionId = crypto.randomUUID();
    const agent = AGENTS[sessionIdx % AGENTS.length];
    const branch = extractBranch(sessionCommits[0].refs) || 'main';

    const entries: Entry[] = sessionCommits.map((c) => {
      const prompt =
        SAMPLE_PROMPTS[Math.floor(Math.random() * SAMPLE_PROMPTS.length)];
      const promptHash = `sha256:${crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16)}`;

      // Get files changed for this commit
      let filesChanged: FileChange[] = [];
      try {
        const numstat = git(
          `diff ${c.fullSha}~1 ${c.fullSha} --numstat`,
          repoRoot
        );
        filesChanged = numstat
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [added, deleted, filePath] = line.split('\t');
            const addedNum = parseInt(added, 10) || 0;
            const deletedNum = parseInt(deleted, 10) || 0;
            return {
              path: filePath,
              linesAdded: Array.from({ length: addedNum }, (_, i) => i + 1),
              linesDeleted: Array.from(
                { length: deletedNum },
                (_, i) => i + 1
              ),
            };
          });
      } catch {
        // First commit has no parent
      }

      return {
        prompt,
        promptHash,
        timestamp: c.date,
        commits: [
          {
            sha: c.shortSha,
            message: c.message,
            filesChanged,
          },
        ],
      };
    });

    const session: Session = {
      sessionId,
      agent,
      branch,
      startedAt: sessionCommits[0].date,
      entries,
    };

    sessions.push(session);

    // Write session file
    const sessionFile = `${sessionId}.json`;
    fs.writeFileSync(
      path.join(sessionsDir, sessionFile),
      JSON.stringify(session, null, 2)
    );

    // Update index
    for (let ei = 0; ei < entries.length; ei++) {
      for (const commit of entries[ei].commits) {
        index[commit.sha] = {
          sessionFile,
          entryIndex: ei,
        };
      }
    }

    sessionIdx++;
  }

  // Write index file
  fs.writeFileSync(
    path.join(intelDir, 'index.json'),
    JSON.stringify(index, null, 2)
  );

  console.log(`\nClaude Git Intel — Demo data seeded!`);
  console.log(`  Directory: ${intelDir}`);
  console.log(`  Sessions:  ${sessions.length}`);
  console.log(
    `  Commits:   ${Object.keys(index).length}`
  );
  console.log(
    `  Files:     ${sessions.reduce((acc, s) => acc + s.entries.reduce((a, e) => a + e.commits.reduce((aa, c) => aa + c.filesChanged.length, 0), 0), 0)}`
  );
  console.log(`\nOpen the repo in VS Code with Claude Git Intel extension to see annotations.`);
}

function extractBranch(refs: string): string | null {
  if (!refs) return null;
  const match = refs.match(/HEAD -> ([^,\s]+)/);
  if (match) return match[1];
  const branchMatch = refs.match(/([^,\s]+)/);
  return branchMatch ? branchMatch[1] : null;
}

main();
