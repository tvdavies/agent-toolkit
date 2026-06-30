import { builtin } from "../factory.js";

export const deterministicExtraction = builtin({
  name: "brain/deterministic-extraction",
  capabilities: ["read-repository", "write-repository"],
  setup(api) {
    api.registerExtractor(
      { id: "brain/deterministic-extraction", extract: (ctx) => ctx.documents },
      { order: 20 },
    );
  },
});
