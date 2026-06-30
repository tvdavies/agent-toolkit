import { builtin } from "../factory.js";

export const llmExtraction = builtin({
  name: "brain/llm-extraction",
  capabilities: ["model-call", "write-repository"],
  setup() {},
});
export const observationWriter = builtin({
  name: "brain/observation-writer",
  capabilities: ["write-repository"],
  setup() {},
});
export const proceduralMemory = builtin({
  name: "brain/procedural-memory",
  capabilities: ["write-repository"],
  setup() {},
});
export const retryLadder = builtin({
  name: "brain/retry-ladder",
  capabilities: ["read-index"],
  setup() {},
});
export const fallbackQueryRewrite = builtin({
  name: "brain/fallback-query-rewrite",
  capabilities: ["model-call"],
  setup() {},
});
export const reflect = builtin({
  name: "brain/reflect",
  capabilities: ["read-repository", "write-repository", "model-call"],
  setup(api) {
    api.registerReflector({ id: "brain/reflect", reflect() {} });
  },
});
export const synthesize = builtin({
  name: "brain/synthesize",
  capabilities: ["read-repository", "write-repository", "model-call"],
  setup(api) {
    api.registerConsolidator({ id: "brain/synthesize", consolidate() {} });
  },
});
/** @deprecated Use brain/reflect. */
export const reflectionSynthesize = builtin({
  name: "brain/reflection-synthesize",
  capabilities: ["read-repository", "write-repository", "model-call"],
  setup(api) {
    api.registerReflector({ id: "brain/reflection-synthesize", reflect() {} });
  },
});
export const patterns = builtin({
  name: "brain/patterns",
  capabilities: ["read-repository", "write-repository"],
  setup(api) {
    api.registerConsolidator({ id: "brain/patterns", consolidate() {} });
  },
});
export const l0WorkingMemory = builtin({
  name: "brain/l0-working-memory",
  capabilities: [],
  setup() {},
});
export const retrievalLog = builtin({
  name: "brain/retrieval-log",
  capabilities: [],
  setup(api) {
    api.on("recall:end", (ctx) =>
      api.runtime.retrievalLog.record({ query: ctx.query, candidates: ctx.candidates.length }),
    );
  },
});
