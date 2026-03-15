/** Token usage for a single assistant response turn */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** A file change produced by a single tool call (Write or Edit) */
export interface FileChange {
  filePath: string;
  toolName: 'Write' | 'Edit';
  /** 'create' for new files, 'update' for edits */
  changeType: 'create' | 'update';
  timestamp: string;
  /** File content before the change (null for new files) */
  contentBefore: string | null;
  /** File content after the change */
  contentAfter: string | null;
}

/** A prompt node in the graph — either a user prompt or a subagent task */
export interface PromptNode {
  /** Unique ID for this node */
  id: string;
  /** The prompt/instruction text */
  prompt: string;
  /** Timestamp of this prompt */
  timestamp: string;
  /** Which model handled it */
  model: string;
  /** Concatenated assistant response text (text + thinking blocks) */
  response: string;
  /** Tools invoked during this prompt's response, with call counts */
  toolsUsed: Array<{ name: string; count: number }>;
  /** Individual tool call inputs, in order of execution */
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  /** Session ID */
  sessionId: string;
  /** Files changed by this prompt (directly or via tool calls) */
  fileChanges: FileChange[];
  /** Subagent nodes spawned from this prompt */
  subagents: SubagentNode[];
  /** Index in the main prompt sequence (for ordering) */
  sequenceIndex: number;
  /** Token usage across all response turns for this prompt */
  tokenUsage: TokenUsage;
}

/** A subagent spawned from a prompt */
export interface SubagentNode {
  /** The agent ID (e.g. "a1500fa9616056f42") */
  agentId: string;
  /** The tool_use ID that spawned this agent */
  toolUseId: string;
  /** Short description from the Agent tool call */
  description: string;
  /** The full prompt sent to the subagent */
  prompt: string;
  /** Agent type (e.g. "Explore", "Plan", "general-purpose") */
  agentType: string;
  /** Timestamp when spawned */
  timestamp: string;
  /** Files changed by this subagent */
  fileChanges: FileChange[];
  /** Color lane index for the graph rendering */
  laneIndex: number;
}

/** The full parsed session graph */
export interface SessionGraph {
  sessionId: string;
  slug: string;
  branch: string;
  startedAt: string;
  /** All user prompt nodes in chronological order */
  prompts: PromptNode[];
  /** Total file changes across all prompts */
  totalFileChanges: number;
  /** Total subagents spawned */
  totalSubagents: number;
  /** Aggregated token counts across all prompts */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Session duration in ms (first to last prompt timestamp) */
  sessionDurationMs: number;
}

/** Raw JSONL entry — minimal fields we care about */
export interface RawTranscriptEntry {
  uuid: string;
  parentUuid: string | null;
  type: 'user' | 'assistant' | 'progress' | 'file-history-snapshot' | 'queue-operation';
  timestamp: string;
  sessionId: string;
  isSidechain: boolean;
  slug?: string;
  gitBranch?: string;
  agentId?: string;
  message?: {
    role: string;
    model?: string;
    content: string | ContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  toolUseResult?: {
    type?: string;
    filePath?: string;
    content?: string;
    originalFile?: string | null;
    oldString?: string;
    newString?: string;
    replaceAll?: boolean;
    structuredPatch?: unknown[];
    // Write tool results nest content under file
    file?: {
      filePath?: string;
      content?: string;
    };
  };
  data?: {
    type?: string;
    agentId?: string;
    prompt?: string;
  };
  toolUseID?: string;
  parentToolUseID?: string;
}

export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}
