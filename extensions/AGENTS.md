# Extension guidance

## Model context limits and usage

When adding or updating a model, review its effective context budget. Do not copy
an upstream 1M/1.05M context window into Pi just because the model supports it.
Larger prompts consume more usage, including when using subscription credentials.
Cheaper cache reads do not remove the need for a context budget.

- Preserve the predecessor's intentional context cap when adding a new version.
- For a new model family, default to at most **272,000 tokens**, or the model's
  supported window if smaller. Use a larger window only when the user explicitly
  requests it, after explaining the usage impact.
- Do not raise an existing smaller cap or change unrelated models as part of a
  catalogue update.
- Keep `maxTokens` separate: it limits output and does not cap accumulated context.
  Do not change output limits, thinking settings or pricing to implement an input
  context cap.

Fable 5, Fable 5.1 and GPT-6-Astra currently use a 272,000-token context budget.
This is a deliberate usage-control choice, not their upstream maximum capacity.

## Check the effective configuration

Model definitions can live in different places:

- `anthropic-claude-code.ts` registers the Claude Code provider's `MODELS` list.
- `~/.pi/agent/models.json` contains user-local models and per-model overrides,
  including `openai-codex/gpt-6-astra`. It is outside this repository and is not
  automatically updated by editing an extension.
- Global and project `.pi/settings.json` files can change compaction settings.

Check the selected provider/model, extension metadata and applicable local
configuration before claiming a cap is effective. Never copy credentials into
repository files or test fixtures.

Pi normally compacts when `contextTokens > contextWindow - reserveTokens`.
With the default 16,384-token reserve, a 272,000-token window triggers compaction
above 255,616 tokens. Verify this against the installed Pi version and settings;
it is an automatic compaction threshold, not a hard spending limit, and disabling
auto-compaction disables this protection.

## Validation and activation

- Add or update regression tests for the intentional context cap. For a successor
  model, check both the expected numeric budget and parity with its predecessor.
- Use local metadata/compaction tests; do not spend live model usage merely to
  validate a numeric limit. Repository tests must not depend on private home files.
- After extension changes, tell the user to run `/reload` and reselect the model.
  After a `models.json` change, reopen `/model` and select the model again. Do not
  claim an already-running session has adopted new metadata without checking it.
