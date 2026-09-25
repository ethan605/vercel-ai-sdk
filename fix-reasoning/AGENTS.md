# fix-reasoning: agent guidance

This repository is a fork of `vercel/ai`. The branch `v3-fixReasoning` carries
one patch on top of the upstream tag `@ai-sdk/openai@3.0.88`. The patch adds a
`fixReasoning` provider option to `@ai-sdk/openai`. OpenCode loads this fork
through the environment variable `OPENAI_SDK_NPM_PATH`, which points at
`packages/openai`.

## Hard rules for agents

- Never edit files that upstream owns. The upstream `AGENTS.md` at the
  repository root is one of them. If you edit it, the next rebase onto a new
  upstream tag conflicts.
- Keep the branch limited to the files the patch already touches, listed
  below, plus files inside `fix-reasoning/` and `.opencode/`.
- Run all gates after every change. The gates are listed under "Build and
  test".

## Why the patch exists

OpenCode talks to Moonshot Kimi K3 through a Bifrost gateway. Bifrost exposes
the OpenAI Responses API, but it is stateless: it does not store responses, so
`item_reference` entries in a request cannot resolve. Stock `@ai-sdk/openai`
does three things that break this setup:

1. It omits the `reasoning` field for models its catalog does not recognize,
   so Kimi K3 receives no reasoning configuration.
2. It sends no `store` field, which defaults to `true` upstream.
3. It replays reasoning items from conversation history as `item_reference`
   entries, which a stateless provider cannot resolve.

With `fixReasoning: true` in the provider options, the patched package instead
sends the `reasoning` field, sends `store: false`, and replays unencrypted
`rs_*` reasoning items inline. When `fixReasoning` is absent or false, the
behavior is identical to stock. The precedence formula in
`openai-responses-language-model.ts` is
`forceReasoning ?? (fixReasoning || modelCapabilities.isReasoningModel)`.

## Files the patch touches

- `packages/openai/src/responses/openai-responses-options.ts` adds the
  `fixReasoning` boolean to the options schema.
- `packages/openai/src/responses/openai-responses-language-model.ts` reads
  `fixReasoning`, applies the precedence formula, defaults `store` to `false`
  when the flag is on, and passes `keepReasoningItemsWithId` to the converter.
  It also derives the provider options name from the configured provider id,
  so a provider named `bifrost` reads `providerOptions.bifrost`.
- `packages/openai/src/responses/convert-to-openai-responses-input.ts` accepts
  `keepReasoningItemsWithId`. When set, reasoning items that carry an `rs_*`
  id stay inline instead of becoming `item_reference` entries. It also falls
  back to the `openai` provider options key for reasoning items when the
  provider-specific key has none.
- Tests live next to both source files. `fix-reasoning/behavior.test.mjs` is
  an end-to-end self-test against the built `dist/`.

## Build and test

Run all of these from the repository root, in this order:

```sh
corepack pnpm install --filter "@ai-sdk/openai..." --frozen-lockfile
corepack pnpm turbo build --filter=@ai-sdk/openai
corepack pnpm --filter @ai-sdk/openai exec tsc --noEmit -p tsconfig.json
corepack pnpm --filter @ai-sdk/openai test
bun fix-reasoning/behavior.test.mjs
```

All four package gates and the self-test must pass. The full suite is 762
tests in the Node environment and 762 in the Edge environment.

## Upgrade to a new upstream version

Run the script from the repository root while on `v3-fixReasoning`:

```sh
fix-reasoning/rebase-onto-tag.sh "@ai-sdk/openai@3.0.<new>"
```

The script tags the current branch tip as a rollback marker, fetches the new
tag from the `upstream` remote, rebases the branch's commits onto it, and
runs all gates. If the rebase stops on a conflict, resolve it, run the script
again without arguments to re-check the gates, then run
`git rebase --continue` and run the script once more with the tag argument.
If the gates pass, push with `git push --force-with-lease origin
v3-fixReasoning` and push the rollback marker tag too. OpenCode needs no
configuration change after an upgrade, because `OPENAI_SDK_NPM_PATH` is a
constant path. Restart OpenCode so it picks up the new build.

## Consumer wiring

Two settings make OpenCode use this fork:

1. The shell exports
   `OPENAI_SDK_NPM_PATH="file:///absolute/path/to/vercel-ai-sdk/packages/openai"`.
   OpenCode resolves `@ai-sdk/openai` from this path for providers that
   declare it.
2. The OpenCode provider configuration sets `fixReasoning: true` in the
   model's provider options, next to `reasoningEffort` and
   `reasoningSummary`.

The file path in the `npm` field has a side effect you must know. OpenCode
recognizes `@ai-sdk/openai` by the literal package name, and its
OpenAI-specific transforms only run on an exact match: injecting
`store: false` into provider options, stripping Responses item IDs from
history, and adding reasoning variant defaults. A `file:///` path disables
all of them. The fork plus the per-model options below replace them.

Use `fixReasoning: true` only for models whose provider never returns
`encrypted_content` on reasoning items, such as Kimi K3 through Bifrost.
Inline replay is the only option there.

For models routed to real OpenAI through a gateway that forces
`store: false` (Bifrost `openai_config.disable_store: true`), set
`store: false` and `forceReasoning: true` in the model options instead. With
`store: false` the converter never emits `item_reference` entries, which a
stateless path cannot resolve, and it drops reasoning items that have no
encrypted content instead of sending them. `forceReasoning` sends the
`reasoning` field for models that the SDK catalog does not know, such as
`gpt-6-luna` and `gpt-6-sol` on the 3.0.88 base, and it makes the SDK request
`reasoning.encrypted_content` so later turns replay reasoning inline. Without
`store: false` in the options, an unset store defaults the converter to
store=true, history items with IDs become `item_reference` entries, and
OpenAI answers 404 `Item with id 'rs_...' not found`.

To set up a new machine, clone the branch, install, and build:

```sh
git clone --branch v3-fixReasoning --single-branch --depth 1 \
  git@github.com:ethan605/vercel-ai-sdk.git ~/personal/vercel-ai-sdk \
  && cd ~/personal/vercel-ai-sdk \
  && corepack pnpm install --filter "@ai-sdk/openai..." --frozen-lockfile \
  && corepack pnpm turbo build --filter=@ai-sdk/openai
```

## Verification against the live gateway

The gateway is a local Bifrost instance. Its logs API serves request and
response bodies when OpenCode runs with `BIFROST_DEBUG=true`. A request from a
model with `fixReasoning: true` must show all of the following in its raw
request body:

- `store` is `false`.
- `reasoning` is present, for example `{ "effort": "high", "summary": "auto" }`.
- Reasoning items appear inline with unencrypted `rs_*` ids, including items
  that earlier responses in the same session produced.
- No `item_reference` entries appear.

A model without the flag must show stock behavior: no `store` key at all, and
reasoning history converted to `item_reference` entries. The Bifrost
deployment repository documents the logs API, including authentication and
query parameters.

## Rollback

If the fork misbehaves, point `OPENAI_SDK_NPM_PATH` back at the previous
working SDK build, or remove the variable so OpenCode uses the published
package, then restart OpenCode. The `v3-fixReasoning@<tag>` rollback markers
preserve earlier branch tips.
