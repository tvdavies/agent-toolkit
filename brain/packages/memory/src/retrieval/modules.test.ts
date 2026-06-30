import { expect, test } from "bun:test";
import { EXECUTABLE_BUILT_IN_RECALL_MODULES } from "./builtin-handlers.js";
import {
  BUILT_IN_RECALL_MODULE_IDS,
  BUILT_IN_RECALL_MODULES,
  RecallModulePlan,
} from "./modules.js";

test("built-in recall module ids are unique", () => {
  expect(new Set(BUILT_IN_RECALL_MODULE_IDS).size).toBe(BUILT_IN_RECALL_MODULE_IDS.length);
});

test("recall module plan checks enabled modules", () => {
  const plan = new RecallModulePlan(["brain/bm25", "brain/rrf"]);

  expect(plan.isEnabled("brain/bm25")).toBe(true);
  expect(plan.isEnabled("brain/vector")).toBe(false);
});

test("recall module plan returns enabled built-ins by stage in config order", () => {
  const plan = new RecallModulePlan([
    "brain/vector",
    "custom/ranker",
    "brain/bm25",
    "brain/authority-boost",
    "brain/cosine-rescore",
  ]);

  expect(plan.enabledBuiltInsByStage("candidate").map((module) => module.id)).toEqual([
    "brain/vector",
    "brain/bm25",
  ]);
  expect(plan.enabledBuiltInsByStage("boost").map((module) => module.id)).toEqual([
    "brain/authority-boost",
    "brain/cosine-rescore",
  ]);
});

test("executable built-in recall modules cover executable built-in ids", () => {
  const known = new Set(BUILT_IN_RECALL_MODULE_IDS.filter((id) => id !== "brain/retrieval-log"));
  const executable = new Set(EXECUTABLE_BUILT_IN_RECALL_MODULES.map((module) => module.id));

  expect(executable).toEqual(known);
});

test("built-in recall modules declare expected stages", () => {
  const byId = new Map(BUILT_IN_RECALL_MODULES.map((module) => [module.id, module.stage]));

  expect(byId.get("brain/bm25")).toBe("candidate");
  expect(byId.get("brain/rrf")).toBe("fuse");
  expect(byId.get("brain/authority-boost")).toBe("boost");
  expect(byId.get("brain/reranker")).toBe("rank");
  expect(byId.get("brain/retrieval-log")).toBe("observe");
});
