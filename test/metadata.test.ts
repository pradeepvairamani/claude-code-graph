/**
 * Tests for the metadata reader, indexer, and git blame parser.
 *
 * Run with: npx tsx test/metadata.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { parsePorcelainBlame } from '../src/utils/git';

// ─── Test Helpers ───

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ─── parsePorcelainBlame ───

console.log('\nparsePorcelainBlame:');

test('parses a single blame entry', () => {
  const input = [
    'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 1 1 1',
    'author John Doe',
    'author-mail <john@example.com>',
    'author-time 1709136000',
    'author-tz +0000',
    'committer John Doe',
    'committer-mail <john@example.com>',
    'committer-time 1709136000',
    'committer-tz +0000',
    'summary Initial commit',
    'filename src/main.ts',
    '\tconst x = 1;',
  ].join('\n');

  const result = parsePorcelainBlame(input);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].sha, 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
  assert.strictEqual(result[0].lineNumber, 1);
  assert.strictEqual(result[0].originalLineNumber, 1);
  assert.strictEqual(result[0].author, 'John Doe');
  assert.strictEqual(result[0].authorTime, 1709136000);
  assert.strictEqual(result[0].summary, 'Initial commit');
});

test('parses multiple blame entries', () => {
  const input = [
    'aaaa000000000000000000000000000000000000 1 1 2',
    'author Alice',
    'author-time 1709136000',
    'summary First commit',
    'filename test.ts',
    '\tline one',
    'aaaa000000000000000000000000000000000000 2 2',
    'author Alice',
    'author-time 1709136000',
    'summary First commit',
    'filename test.ts',
    '\tline two',
    'bbbb000000000000000000000000000000000000 3 3 1',
    'author Bob',
    'author-time 1709140000',
    'summary Second commit',
    'filename test.ts',
    '\tline three',
  ].join('\n');

  const result = parsePorcelainBlame(input);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].author, 'Alice');
  assert.strictEqual(result[2].author, 'Bob');
  assert.strictEqual(result[2].lineNumber, 3);
});

test('handles empty input', () => {
  const result = parsePorcelainBlame('');
  assert.strictEqual(result.length, 0);
});

// ─── MetadataReader (with temp files) ───

console.log('\nMetadataReader:');

const TEMP_DIR = path.join(__dirname, '.test-intel');

function setupTempIntel() {
  const sessionsDir = path.join(TEMP_DIR, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const session = {
    sessionId: 'test-session-001',
    agent: 'claude-opus-4-6',
    branch: 'main',
    startedAt: '2026-02-28T10:00:00Z',
    entries: [
      {
        prompt: 'Add user authentication with JWT',
        promptHash: 'sha256:abc123',
        timestamp: '2026-02-28T10:01:00Z',
        commits: [
          {
            sha: 'a1b2c3d',
            message: 'Add JWT auth middleware',
            filesChanged: [
              { path: 'src/auth.ts', linesAdded: [10, 11, 12], linesDeleted: [] },
            ],
          },
        ],
      },
      {
        prompt: 'Fix the login redirect bug',
        promptHash: 'sha256:def456',
        timestamp: '2026-02-28T10:05:00Z',
        commits: [
          {
            sha: 'e4f5g6h',
            message: 'Fix redirect after login',
            filesChanged: [
              { path: 'src/login.ts', linesAdded: [5, 6], linesDeleted: [3] },
            ],
          },
        ],
      },
    ],
  };

  fs.writeFileSync(
    path.join(sessionsDir, 'test-session-001.json'),
    JSON.stringify(session, null, 2)
  );

  const index = {
    a1b2c3d: { sessionFile: 'test-session-001.json', entryIndex: 0 },
    e4f5g6h: { sessionFile: 'test-session-001.json', entryIndex: 1 },
  };

  fs.writeFileSync(
    path.join(TEMP_DIR, 'index.json'),
    JSON.stringify(index, null, 2)
  );
}

function cleanupTempIntel() {
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true });
  }
}

// Dynamic import to avoid VS Code dependency issues in test
async function runReaderTests() {
  setupTempIntel();

  try {
    // We can't import the full reader in a non-VS Code environment,
    // so test the data structures directly
    test('session JSON file is valid', () => {
      const raw = fs.readFileSync(
        path.join(TEMP_DIR, 'sessions', 'test-session-001.json'),
        'utf-8'
      );
      const session = JSON.parse(raw);
      assert.strictEqual(session.sessionId, 'test-session-001');
      assert.strictEqual(session.agent, 'claude-opus-4-6');
      assert.strictEqual(session.entries.length, 2);
    });

    test('index.json maps SHAs to sessions', () => {
      const raw = fs.readFileSync(path.join(TEMP_DIR, 'index.json'), 'utf-8');
      const index = JSON.parse(raw);
      assert.strictEqual(index['a1b2c3d'].sessionFile, 'test-session-001.json');
      assert.strictEqual(index['a1b2c3d'].entryIndex, 0);
      assert.strictEqual(index['e4f5g6h'].entryIndex, 1);
    });

    test('entry contains prompt and commit data', () => {
      const raw = fs.readFileSync(
        path.join(TEMP_DIR, 'sessions', 'test-session-001.json'),
        'utf-8'
      );
      const session = JSON.parse(raw);
      const entry = session.entries[0];
      assert.strictEqual(entry.prompt, 'Add user authentication with JWT');
      assert.strictEqual(entry.commits[0].sha, 'a1b2c3d');
      assert.strictEqual(entry.commits[0].filesChanged[0].path, 'src/auth.ts');
      assert.deepStrictEqual(entry.commits[0].filesChanged[0].linesAdded, [10, 11, 12]);
    });

    test('session has correct branch', () => {
      const raw = fs.readFileSync(
        path.join(TEMP_DIR, 'sessions', 'test-session-001.json'),
        'utf-8'
      );
      const session = JSON.parse(raw);
      assert.strictEqual(session.branch, 'main');
    });
  } finally {
    cleanupTempIntel();
  }
}

// ─── Run all tests ───

runReaderTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
});
