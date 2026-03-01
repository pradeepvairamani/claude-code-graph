import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BlameLine } from '../metadata/types';

const execFileAsync = promisify(execFile);

/**
 * Run a git command in the given working directory.
 */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Parse `git blame --porcelain` output into structured BlameLine entries.
 */
export function parsePorcelainBlame(output: string): BlameLine[] {
  const lines = output.split('\n');
  const result: BlameLine[] = [];
  let current: Partial<BlameLine> = {};

  for (const line of lines) {
    // Header line: <sha> <orig-line> <final-line> [<num-lines>]
    const headerMatch = line.match(
      /^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+\d+)?$/
    );
    if (headerMatch) {
      current = {
        sha: headerMatch[1],
        originalLineNumber: parseInt(headerMatch[2], 10),
        lineNumber: parseInt(headerMatch[3], 10),
      };
      continue;
    }

    if (line.startsWith('author ')) {
      current.author = line.slice(7);
    } else if (line.startsWith('author-time ')) {
      current.authorTime = parseInt(line.slice(12), 10);
    } else if (line.startsWith('summary ')) {
      current.summary = line.slice(8);
    } else if (line.startsWith('\t')) {
      // Content line — signals end of this blame entry
      if (current.sha && current.lineNumber !== undefined) {
        result.push(current as BlameLine);
      }
      current = {};
    }
  }

  return result;
}

/**
 * Run `git blame --porcelain` on a file and return structured results.
 */
export async function blame(
  filePath: string,
  cwd: string
): Promise<BlameLine[]> {
  const output = await git(['blame', '--porcelain', filePath], cwd);
  return parsePorcelainBlame(output);
}

/**
 * Get the root of the git repository.
 */
export async function getRepoRoot(cwd: string): Promise<string> {
  const root = await git(['rev-parse', '--show-toplevel'], cwd);
  return root.trim();
}

/**
 * Check if a directory is inside a git repository.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return branch.trim();
}

/**
 * Get the short SHA for a full commit hash.
 */
export async function shortSha(fullSha: string, cwd: string): Promise<string> {
  const short = await git(['rev-parse', '--short', fullSha], cwd);
  return short.trim();
}
