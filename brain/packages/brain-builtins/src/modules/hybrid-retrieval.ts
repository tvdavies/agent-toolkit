import { builtin } from "../factory.js";

export const hybridRetrieval = builtin({
  name: "brain/hybrid-retrieval",
  capabilities: ["read-index"],
  setup(api) {
    api.registerCandidateGenerator(
      {
        id: "brain/hybrid-retrieval",
        async generate(ctx) {
          return api.index.searchText({ query: ctx.query });
        },
      },
      { order: 0 },
    );
  },
});
