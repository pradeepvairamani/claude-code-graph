#!/usr/bin/env node
/**
 * CLI entry point for testing Claude Git Intel outside of VS Code.
 * Exercises the metadata reader, git blame parser, and indexer.
 *
 * Usage:
 *   npx tsx src/cli.ts [file-path]
 *   npx tsx src/cli.ts --query <sha>
 *   npx tsx src/cli.ts --status
 */

import * as path from 'path';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { MetadataReader } from './metadata/reader';
import { LineIndexer } from './metadata/indexer';
import { parsePorcelainBlame } from './utils/git';

function getRepoRoot(): string {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}

function gitBlame(filePath: string, cwd: string): string {
  return execSync(`git blame --porcelain "${filePath}"`, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function main() {
  const args = process.argv.slice(2);

  let repoRoot: string;
  try {
    repoRoot = getRepoRoot();
  } catch {
    console.error('Error: not inside a git repository');
    process.exit(1);
  }

  const intelDir = path.join(repoRoot, '.claude', 'intel');
  const reader = new MetadataReader(intelDir);
  const indexer = new LineIndexer(reader);

  if (!reader.exists()) {
    console.error(`No intel data found at ${intelDir}`);
    console.error('Run: npm run seed-demo   to generate demo data');
    process.exit(1);
  }

  // --status: show summary of intel data
  if (args[0] === '--status') {
    const index = reader.readIndex();
    const sessions = reader.readAllSessions();
    const commitCount = Object.keys(index).length;
    const entryCount = sessions.reduce((a, s) => a + s.entries.length, 0);

    console.log('\nClaude Git Intel — Status');
    console.log('─'.repeat(40));
    console.log(`  Intel directory:  ${intelDir}`);
    console.log(`  Sessions:         ${sessions.length}`);
    console.log(`  Prompt entries:   ${entryCount}`);
    console.log(`  Tracked commits:  ${commitCount}`);
    console.log();

    for (const session of sessions) {
      console.log(`  Session ${session.sessionId.slice(0, 8)} (${session.agent})`);
      console.log(`    Branch: ${session.branch}`);
      console.log(`    Started: ${session.startedAt}`);
      for (const entry of session.entries) {
        const commitShas = entry.commits.map((c) => c.sha).join(', ');
        console.log(`    → "${truncate(entry.prompt, 50)}" → [${commitShas}]`);
      }
      console.log();
    }
    return;
  }

  // --query <sha>: look up a specific commit
  if (args[0] === '--query' && args[1]) {
    const sha = args[1];
    const index = reader.readIndex();
    const entry = index[sha];

    if (!entry) {
      console.log(`No intel data for commit ${sha}`);
      console.log(`Known commits: ${Object.keys(index).join(', ')}`);
      process.exit(1);
    }

    const session = reader.readSession(entry.sessionFile);
    if (!session) {
      console.error(`Session file not found: ${entry.sessionFile}`);
      process.exit(1);
    }

    const promptEntry = session.entries[entry.entryIndex];
    console.log('\nClaude Git Intel — Commit Lineage');
    console.log('─'.repeat(40));
    console.log(`  Commit:    ${sha}`);
    console.log(`  Prompt:    ${promptEntry.prompt}`);
    console.log(`  Agent:     ${session.agent}`);
    console.log(`  Session:   ${session.sessionId}`);
    console.log(`  Branch:    ${session.branch}`);
    console.log(`  Timestamp: ${promptEntry.timestamp}`);
    console.log(`  Hash:      ${promptEntry.promptHash}`);
    if (promptEntry.commits.length > 0) {
      console.log(`  Message:   ${promptEntry.commits[0].message}`);
      console.log(`  Files:`);
      for (const commit of promptEntry.commits) {
        for (const fc of commit.filesChanged) {
          console.log(`    ${fc.path} (+${fc.linesAdded.length} -${fc.linesDeleted.length})`);
        }
      }
    }
    console.log();
    return;
  }

  // Default: blame a file and show AI annotations
  const filePath = args[0];
  if (!filePath) {
    console.log('Usage:');
    console.log('  npx tsx src/cli.ts <file-path>     Blame a file, show AI annotations');
    console.log('  npx tsx src/cli.ts --query <sha>    Look up prompt lineage for a commit');
    console.log('  npx tsx src/cli.ts --status          Show intel data summary');
    process.exit(0);
  }

  const relativePath = path.relative(repoRoot, path.resolve(filePath));

  let blameOutput: string;
  try {
    blameOutput = gitBlame(relativePath, repoRoot);
  } catch (err: any) {
    console.error(`git blame failed for ${relativePath}: ${err.message}`);
    process.exit(1);
  }

  const blameLines = parsePorcelainBlame(blameOutput);
  const lineMap = indexer.resolveLines(blameLines);

  // Read the file content to display alongside annotations
  const fullPath = path.join(repoRoot, relativePath);
  const fileLines = fs.readFileSync(fullPath, 'utf-8').split('\n');

  console.log(`\nClaude Git Intel — ${relativePath}`);
  console.log('─'.repeat(60));

  const maxLineNumWidth = String(fileLines.length).length;

  for (let i = 0; i < fileLines.length; i++) {
    const lineNum = i + 1; // git blame uses 1-indexed lines
    const info = lineMap.get(lineNum);
    const lineNumStr = String(lineNum).padStart(maxLineNumWidth, ' ');
    const code = fileLines[i];

    if (info) {
      const prompt = truncate(info.prompt, 40);
      console.log(
        `  ${lineNumStr} │ ${padRight(code, 50)} │ AI · ${prompt}`
      );
    } else {
      console.log(`  ${lineNumStr} │ ${code}`);
    }
  }

  const aiLines = lineMap.size;
  const totalLines = fileLines.length;
  const pct = totalLines > 0 ? Math.round((aiLines / totalLines) * 100) : 0;
  console.log('─'.repeat(60));
  console.log(`  AI-authored: ${aiLines}/${totalLines} lines (${pct}%)\n`);
}

function truncate(text: string, maxLen: number): string {
  const singleLine = text.replace(/\n/g, ' ').trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 1) + '…';
}

function padRight(text: string, len: number): string {
  if (text.length >= len) return text.slice(0, len);
  return text + ' '.repeat(len - text.length);
}

main();
