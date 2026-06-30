import type { BrainExtensionAPI, BrainModule, Capability } from "@ai-assistant/brain-core";

export interface BuiltinModuleSpec {
  name: string;
  capabilities: Capability[];
  setup(api: BrainExtensionAPI): void;
}

/** Create a versioned built-in BrainModule with a consistent brain/ namespace. */
export function builtin(spec: BuiltinModuleSpec): BrainModule {
  return {
    name: spec.name,
    version: "0.1.0",
    capabilities: spec.capabilities,
    setup: spec.setup,
  };
}
