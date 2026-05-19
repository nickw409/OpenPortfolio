#!/usr/bin/env bash
# Remove a worktree (must be clean). The branch is preserved unless you also
# `git branch -d <branch>`. Pass the branch name; the slugified directory is
# derived.
#
# Usage: scripts/worktree-rm.sh <branch>
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: $0 <branch>" >&2
    exit 2
fi

branch=$1
slug=${branch//\//-}
dir=worktrees/$slug

git worktree remove "$dir"
echo "Worktree $dir removed."
