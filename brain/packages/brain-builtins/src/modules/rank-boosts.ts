import { builtin } from "../factory.js";

export const authorityBoost = builtin({
  name: "brain/authority-boost",
  capabilities: ["read-index"],
  setup(api) {
    api.registerRanker(
      { id: "brain/authority-boost", rank: (ctx) => ctx.candidates },
      { order: 40 },
    );
  },
});

export const backlinkBoost = builtin({
  name: "brain/backlink-boost",
  capabilities: ["read-index"],
  setup(api) {
    api.registerRanker(
      { id: "brain/backlink-boost", rank: (ctx) => ctx.candidates },
      { order: 50 },
    );
  },
});

export const usageBoost = builtin({
  name: "brain/usage-boost",
  capabilities: ["read-index"],
  setup(api) {
    api.registerRanker({ id: "brain/usage-boost", rank: (ctx) => ctx.candidates }, { order: 60 });
  },
});
