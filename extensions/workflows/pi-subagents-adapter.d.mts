import type { Message } from "@earendil-works/pi-ai";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  mcpDirectTools?: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: string;
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  defaultContext?: "fresh" | "fork";
  systemPrompt: string;
  source: "builtin" | "user" | "project";
  filePath: string;
  skills?: string[];
  extensions?: string[];
  output?: string;
  defaultReads?: string[];
  defaultProgress?: boolean;
  interactive?: boolean;
  maxSubagentDepth?: number;
  maxExecutionTimeMs?: number;
  maxTokens?: number;
  completionGuard?: boolean;
  disabled?: boolean;
  [key: string]: unknown;
}

export function discoverAgents(cwd: string, scope?: AgentScope): {
  agents: AgentConfig[];
  projectAgentsDir?: string;
  userAgentsDir?: string;
};

export interface StructuredOutputRuntime {
  schema: Record<string, unknown>;
  schemaPath: string;
  outputPath: string;
}

export function createStructuredOutputRuntime(schema: Record<string, unknown>, baseDir?: string): StructuredOutputRuntime;
export function readStructuredOutput(runtime: StructuredOutputRuntime): { value?: unknown; error?: string };
export function cleanupStructuredOutputRuntime(runtime: StructuredOutputRuntime | undefined): void;

export interface RunSyncResult {
  exitCode: number;
  finalOutput?: string;
  messages?: Message[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };
  error?: string;
  timedOut?: boolean;
  interrupted?: boolean;
  structuredOutput?: unknown;
  sessionFile?: string;
  model?: string;
  attemptedModels?: string[];
  modelAttempts?: Array<{ model: string; success: boolean; exitCode?: number | null; error?: string }>;
}

export function runSync(
  cwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  options: Record<string, unknown>,
): Promise<RunSyncResult>;
