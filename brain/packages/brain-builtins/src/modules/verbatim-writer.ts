import { builtin } from "../factory.js";

export const verbatimWriter = builtin({
  name: "brain/verbatim-writer",
  capabilities: ["write-repository"],
  setup(api) {
    api.registerWriter(
      {
        id: "brain/verbatim-writer",
        write: (ctx) => ctx.documents,
      },
      { order: 0 },
    );
  },
});
