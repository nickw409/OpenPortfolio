#!/usr/bin/env bash
# Create a worktree at worktrees/<slug> for branch <name>, optionally branching
# from <base> (default HEAD).
#
# Slug-flattening: branch `feat/foo` lives at `worktrees/feat-foo/`. The
# branch name keeps its slashes; only the directory slug is flat. This is
# because Claude Code's `Bash(...)` permission patterns use `*` which does
# NOT span `/`, so committed entries like `Bash(git -C worktrees/* log*)`
# would miss any nested directory and force re-prompts.
#
# Also copies the user's .claude/settings.local.json into the new worktree
# if present (gitignored, so it doesn't follow into worktrees automatically).
#
# Usage: scripts/worktree-add.sh <branch> [<base>]
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: $0 <branch> [<base>]" >&2
    exit 2
fi

branch=$1
base=${2:-HEAD}
slug=${branch//\//-}
dir=worktrees/$slug

git worktree add "$dir" -b "$branch" "$base"

if [[ -f .claude/settings.local.json ]]; then
    mkdir -p "$dir/.claude"
    cp .claude/settings.local.json "$dir/.claude/"
    echo "Copied .claude/settings.local.json into $dir/.claude/"
fi

echo
echo "Worktree ready: $dir (branch: $branch)"
echo "Next: cd $dir && pnpm install"
