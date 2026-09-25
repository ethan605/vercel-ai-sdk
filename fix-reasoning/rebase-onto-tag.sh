#!/bin/sh
# Usage: fix-reasoning/rebase-onto-tag.sh "@ai-sdk/openai@3.0.117"
# Run while on v3-fixReasoning. Rebases the branch's commits onto $tag.
set -eu
rebase_in_progress=false
if git rev-parse -q --verify REBASE_HEAD >/dev/null; then
  echo "rebase in progress; assuming conflicts resolved — running gates"
  rebase_in_progress=true
else
  tag=$1
  old=$(git describe --tags --abbrev=0 --match '@ai-sdk/openai@*' HEAD)   # the openai tag this branch sits on (other packages' tags can share the commit)
  git tag -f "v3-fixReasoning@$old" v3-fixReasoning   # rollback marker
  git fetch --depth 1 upstream "refs/tags/$tag:refs/tags/$tag"
  git rebase --onto "$tag" "$old" v3-fixReasoning
  echo "After gates pass, also push the rollback marker: git push origin \"v3-fixReasoning@$old\"" >&2
fi
corepack pnpm install --filter "@ai-sdk/openai..." --frozen-lockfile
corepack pnpm turbo build --filter=@ai-sdk/openai
corepack pnpm --filter @ai-sdk/openai exec tsc --noEmit -p tsconfig.json
corepack pnpm --filter @ai-sdk/openai test
bun fix-reasoning/behavior.test.mjs
if [ "$rebase_in_progress" = true ]; then
  echo "gates green on the resolved tree; now run: git rebase --continue, then re-run this script with the tag argument"
  exit 0
fi
echo "Gates green. Push: git push --force-with-lease origin v3-fixReasoning"
echo "Then restart OpenCode. opencode.json needs no change (constant path)."
