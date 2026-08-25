// Keep pi-subagents' unstable deep imports behind one runtime-only JavaScript seam.
// pi-subagents ships TypeScript source rather than declarations; the adjacent .d.ts
// describes only the small surface this extension uses so toolkit type-checking does
// not recursively validate a third-party package under this repository's stricter flags.
export { discoverAgents } from "pi-subagents/src/agents/agents.ts";
export { runSync } from "pi-subagents/src/runs/foreground/execution.ts";
export {
  cleanupStructuredOutputRuntime,
  createStructuredOutputRuntime,
  readStructuredOutput,
} from "pi-subagents/src/runs/shared/structured-output.ts";
