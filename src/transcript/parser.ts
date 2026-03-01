import * as fs from 'fs';
import * as path from 'path';
import type {
  RawTranscriptEntry,
  ContentBlock,
  SessionGraph,
  PromptNode,
  SubagentNode,
  FileChange,
} from './types';

/**
 * Parse a Claude Code JSONL transcript into a SessionGraph
 * suitable for the prompt graph visualization.
 */
export class TranscriptParser {
  /**
   * Parse a session JSONL file and its subagent files into a SessionGraph.
   */
  parseSession(sessionJsonlPath: string): SessionGraph | null {
    if (!fs.existsSync(sessionJsonlPath)) {
      return null;
    }

    const entries = this.readJsonl(sessionJsonlPath);
    if (entries.length === 0) {
      return null;
    }

    // Find session metadata from first user entry
    const firstUser = entries.find(e => e.type === 'user' && !e.isSidechain);
    const sessionId = firstUser?.sessionId || '';
    const slug = firstUser?.slug || '';
    const branch = firstUser?.gitBranch || 'HEAD';
    const startedAt = firstUser?.timestamp || '';

    // Build lookup maps
    const entryByUuid = new Map<string, RawTranscriptEntry>();
    for (const entry of entries) {
      entryByUuid.set(entry.uuid, entry);
    }

    // Extract the main conversation chain (non-sidechain)
    const mainEntries = entries.filter(e => !e.isSidechain);

    // Find user prompts (external user messages, not tool results)
    const userPrompts: Array<{ entry: RawTranscriptEntry; index: number }> = [];
    for (let i = 0; i < mainEntries.length; i++) {
      const entry = mainEntries[i];
      if (entry.type === 'user' && this.isUserPrompt(entry)) {
        userPrompts.push({ entry, index: userPrompts.length });
      }
    }

    // For each user prompt, collect:
    // 1. File changes from subsequent assistant tool calls
    // 2. Subagent spawns
    const prompts: PromptNode[] = [];
    let laneCounter = 0;

    for (let pi = 0; pi < userPrompts.length; pi++) {
      const { entry: promptEntry, index: seqIndex } = userPrompts[pi];
      const promptText = this.extractPromptText(promptEntry);
      const promptUuid = promptEntry.uuid;

      // Collect all assistant responses and tool results between this prompt
      // and the next user prompt
      const nextPromptUuid = pi + 1 < userPrompts.length
        ? userPrompts[pi + 1].entry.uuid
        : null;

      const responseEntries = this.collectResponseEntries(
        mainEntries, promptUuid, nextPromptUuid
      );

      // Extract file changes from tool calls in responses
      const fileChanges = this.extractFileChanges(responseEntries, entryByUuid);

      // Extract subagent spawns from Agent tool calls
      const subagentSpawns = this.extractSubagentSpawns(
        responseEntries, entries, entryByUuid
      );

      // Parse subagent JSONL files for their file changes
      const sessionDir = this.getSessionDir(sessionJsonlPath);
      const subagents: SubagentNode[] = [];

      for (const spawn of subagentSpawns) {
        const subagentFileChanges = this.parseSubagentFileChanges(
          sessionDir, spawn.agentId
        );

        subagents.push({
          agentId: spawn.agentId,
          toolUseId: spawn.toolUseId,
          description: spawn.description,
          prompt: spawn.prompt,
          agentType: spawn.agentType,
          timestamp: spawn.timestamp,
          fileChanges: subagentFileChanges,
          laneIndex: laneCounter++,
        });
      }

      // Find the model from the first assistant response
      const firstAssistant = responseEntries.find(e => e.type === 'assistant');
      const model = (firstAssistant?.message as { model?: string } | undefined)?.model || 'unknown';

      prompts.push({
        id: promptUuid,
        prompt: promptText,
        timestamp: promptEntry.timestamp,
        model,
        sessionId,
        fileChanges,
        subagents,
        sequenceIndex: seqIndex,
      });
    }

    // Calculate totals
    let totalFileChanges = 0;
    let totalSubagents = 0;
    for (const p of prompts) {
      totalFileChanges += p.fileChanges.length;
      totalSubagents += p.subagents.length;
      for (const sa of p.subagents) {
        totalFileChanges += sa.fileChanges.length;
      }
    }

    return {
      sessionId,
      slug,
      branch,
      startedAt,
      prompts,
      totalFileChanges,
      totalSubagents,
    };
  }

  /**
   * Read a JSONL file into parsed entries.
   */
  readJsonl(filePath: string): RawTranscriptEntry[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const entries: RawTranscriptEntry[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  /**
   * Check if a user entry is an actual human prompt (not a tool result).
   */
  private isUserPrompt(entry: RawTranscriptEntry): boolean {
    if (!entry.message) { return false; }
    const content = entry.message.content;

    // If content is a string, it's a user prompt
    if (typeof content === 'string') {
      return content.length > 0;
    }

    // If content is an array, check if it's a tool_result (not a prompt)
    if (Array.isArray(content)) {
      const hasToolResult = content.some(
        (block: ContentBlock) => block.type === 'tool_result'
      );
      if (hasToolResult) { return false; }

      // Check for text content
      return content.some(
        (block: ContentBlock) => block.type === 'text' && block.text && block.text.length > 0
      );
    }

    return false;
  }

  /**
   * Extract the prompt text from a user entry.
   */
  private extractPromptText(entry: RawTranscriptEntry): string {
    if (!entry.message) { return ''; }
    const content = entry.message.content;

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const textBlocks = content
        .filter((b: ContentBlock) => b.type === 'text' && b.text)
        .map((b: ContentBlock) => b.text!);
      return textBlocks.join('\n');
    }

    return '';
  }

  /**
   * Collect all entries between a user prompt and the next user prompt.
   */
  private collectResponseEntries(
    mainEntries: RawTranscriptEntry[],
    afterUuid: string,
    beforeUuid: string | null
  ): RawTranscriptEntry[] {
    const result: RawTranscriptEntry[] = [];
    let started = false;

    for (const entry of mainEntries) {
      if (entry.uuid === afterUuid) {
        started = true;
        continue;
      }
      if (started) {
        if (beforeUuid && entry.uuid === beforeUuid) { break; }
        result.push(entry);
      }
    }

    return result;
  }

  /**
   * Extract file changes from assistant tool calls and their results.
   */
  private extractFileChanges(
    responseEntries: RawTranscriptEntry[],
    entryByUuid: Map<string, RawTranscriptEntry>
  ): FileChange[] {
    const changes: FileChange[] = [];

    // Build a map of tool_use_id → tool name so we can skip Read results
    const toolNameById = new Map<string, string>();
    for (const entry of responseEntries) {
      if (entry.type === 'assistant' && entry.message) {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use' && block.id && block.name) {
              toolNameById.set(block.id, block.name);
            }
          }
        }
      }
    }

    // Collect tool_use IDs that have a corresponding tool result
    const handledToolUseIds = new Set<string>();

    // First pass: collect from tool results (user entries with toolUseResult)
    for (const entry of responseEntries) {
      if (entry.type !== 'user' || !entry.toolUseResult) { continue; }
      const result = entry.toolUseResult;

      // Find the tool_use_id for this result to check the tool name
      const content = entry.message?.content;
      let toolUseId: string | undefined;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            toolUseId = b.tool_use_id;
            break;
          }
        }
      }

      // Skip results from Read/Glob/Grep/etc — only process Write and Edit
      const toolName = toolUseId ? toolNameById.get(toolUseId) : undefined;
      if (toolName && toolName !== 'Write' && toolName !== 'Edit') {
        continue;
      }

      // Edit results: { filePath, originalFile, oldString, newString }
      if (result.filePath && result.originalFile !== undefined) {
        const before = result.originalFile ?? '';
        const after = this.applyEdit(before, result.oldString, result.newString, result.replaceAll);
        changes.push({
          filePath: result.filePath,
          toolName: 'Edit',
          changeType: 'update',
          timestamp: entry.timestamp,
          contentBefore: before,
          contentAfter: after,
        });
        if (toolUseId) { handledToolUseIds.add(toolUseId); }
        continue;
      }

      // Write results: { type: "text", file: { filePath, content } }
      if (result.file?.filePath && toolName === 'Write') {
        changes.push({
          filePath: result.file.filePath,
          toolName: 'Write',
          changeType: 'create',
          timestamp: entry.timestamp,
          contentBefore: null,
          contentAfter: result.file.content ?? null,
        });
        if (toolUseId) { handledToolUseIds.add(toolUseId); }
      }
    }

    // Second pass: pick up tool_use calls that don't have results yet (live updates)
    for (const entry of responseEntries) {
      if (entry.type !== 'assistant' || !entry.message) { continue; }
      const content = entry.message.content;
      if (!Array.isArray(content)) { continue; }

      for (const block of content) {
        if (block.type !== 'tool_use' ||
            (block.name !== 'Write' && block.name !== 'Edit') ||
            !block.input?.file_path) { continue; }

        if (block.id && handledToolUseIds.has(block.id)) { continue; }

        // Check if we already collected a result for this file at a similar time
        const fp = block.input.file_path as string;
        const hasResult = changes.some(c =>
          c.filePath === fp &&
          Math.abs(new Date(c.timestamp).getTime() - new Date(entry.timestamp).getTime()) < 5000
        );
        if (!hasResult) {
          changes.push({
            filePath: fp,
            toolName: block.name as 'Write' | 'Edit',
            changeType: block.name === 'Write' ? 'create' : 'update',
            timestamp: entry.timestamp,
            contentBefore: null,
            contentAfter: (block.input.content as string) || null,
          });
        }
      }
    }

    return this.deduplicateChanges(changes);
  }

  /**
   * Apply an Edit operation (oldString → newString) to file content.
   */
  private applyEdit(
    content: string,
    oldString?: string,
    newString?: string,
    replaceAll?: boolean
  ): string {
    if (!oldString || newString === undefined) { return content; }
    if (replaceAll) {
      return content.split(oldString).join(newString);
    }
    const idx = content.indexOf(oldString);
    if (idx === -1) { return content; }
    return content.slice(0, idx) + newString + content.slice(idx + oldString.length);
  }

  /**
   * Extract subagent spawn info from Agent tool calls.
   */
  private extractSubagentSpawns(
    responseEntries: RawTranscriptEntry[],
    allEntries: RawTranscriptEntry[],
    entryByUuid: Map<string, RawTranscriptEntry>
  ): Array<{
    agentId: string;
    toolUseId: string;
    description: string;
    prompt: string;
    agentType: string;
    timestamp: string;
  }> {
    const spawns: Array<{
      agentId: string;
      toolUseId: string;
      description: string;
      prompt: string;
      agentType: string;
      timestamp: string;
    }> = [];

    // Look for Agent tool_use calls in assistant messages
    const agentCalls = new Map<string, {
      toolUseId: string;
      description: string;
      prompt: string;
      agentType: string;
      timestamp: string;
    }>();

    for (const entry of responseEntries) {
      if (entry.type === 'assistant' && entry.message) {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use' && block.name === 'Agent' && block.input) {
              agentCalls.set(block.id!, {
                toolUseId: block.id!,
                description: (block.input.description as string) || '',
                prompt: (block.input.prompt as string) || '',
                agentType: (block.input.subagent_type as string) || 'general-purpose',
                timestamp: entry.timestamp,
              });
            }
          }
        }
      }
    }

    // Find corresponding agent_progress events to get agentId
    for (const entry of allEntries) {
      if (entry.type === 'progress' && entry.data?.type === 'agent_progress') {
        const parentToolId = entry.parentToolUseID;
        if (parentToolId && agentCalls.has(parentToolId)) {
          const call = agentCalls.get(parentToolId)!;
          spawns.push({
            ...call,
            agentId: entry.data.agentId || entry.toolUseID || '',
          });
          agentCalls.delete(parentToolId);
        }
      }
    }

    // Any remaining calls without progress events — use toolUseId as agentId
    for (const [toolUseId, call] of agentCalls) {
      spawns.push({
        ...call,
        agentId: toolUseId,
      });
    }

    return spawns;
  }

  /**
   * Parse a subagent's JSONL file for file changes.
   */
  private parseSubagentFileChanges(
    sessionDir: string | null,
    agentId: string
  ): FileChange[] {
    if (!sessionDir) { return []; }

    const subagentFile = path.join(sessionDir, 'subagents', `agent-${agentId}.jsonl`);
    if (!fs.existsSync(subagentFile)) { return []; }

    const entries = this.readJsonl(subagentFile);
    const entryByUuid = new Map<string, RawTranscriptEntry>();
    for (const entry of entries) {
      entryByUuid.set(entry.uuid, entry);
    }

    return this.extractFileChanges(entries, entryByUuid);
  }

  /**
   * Get the session directory (where subagent files live).
   * For /path/to/session-id.jsonl → /path/to/session-id/
   */
  private getSessionDir(sessionJsonlPath: string): string | null {
    const dir = sessionJsonlPath.replace(/\.jsonl$/, '');
    return fs.existsSync(dir) ? dir : null;
  }

  /**
   * Deduplicate file changes by path, keeping the first contentBefore
   * and the last contentAfter so diffs reflect the full change.
   */
  private deduplicateChanges(changes: FileChange[]): FileChange[] {
    const seen = new Map<string, FileChange>();
    for (const change of changes) {
      const existing = seen.get(change.filePath);
      if (!existing) {
        seen.set(change.filePath, { ...change });
      } else {
        // Keep first contentBefore, update to latest contentAfter/timestamp
        existing.contentAfter = change.contentAfter ?? existing.contentAfter;
        existing.timestamp = change.timestamp;
        // If any change is a 'create', keep that type
        if (change.changeType === 'create') {
          existing.changeType = 'create';
        }
      }
    }
    return Array.from(seen.values());
  }
}
