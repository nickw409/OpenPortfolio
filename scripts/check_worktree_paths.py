#!/usr/bin/env python3
"""PreToolUse Bash hook: reject absolute paths into the repo.

The committed `.claude/settings.json` allowlist matches relative forms for
Bash patterns:

- For the main repo: bare commands like `git status` / `pnpm test` (cwd is
  the repo root).
- For worktrees: `worktrees/<name>/...` via `git -C` / `pnpm -C` / full
  binary paths under `worktrees/<name>/node_modules/.bin/`.

The absolute forms — `<repo-root>/...` and `<repo-root>/worktrees/<name>/...`
— bypass the allowlist (`*` in permission patterns matches at the literal
pattern position) and force re-prompts. This hook catches both mistakes
before the prompt fires and tells the agent the relative form to use.

Read/Edit/Write file paths are the opposite: those MUST be absolute. This
hook only fires on Bash, so those tools are unaffected.

Uses `git rev-parse --git-common-dir` so the same hook works whether the
session was started from the main repo or from inside a worktree (the
common dir is shared across worktrees, and dirname-of-it is the main repo).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0

    cmd = payload.get("tool_input", {}).get("command", "")
    if not cmd:
        return 0

    try:
        common_dir = subprocess.check_output(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return 0

    main_repo = os.path.dirname(common_dir)
    worktree_prefix = f"{main_repo}/worktrees/"

    if worktree_prefix in cmd:
        message = (
            f"Use the relative form `worktrees/<name>/...` from the repo root, "
            f"not the absolute `{worktree_prefix}<name>/...`. Absolute paths "
            f"bypass the committed Bash allowlist (`*` matches at the literal "
            f"pattern position) and force re-prompts. Use cwd-free forms: "
            f"`git -C worktrees/<name> <cmd>`, "
            f"`pnpm -C worktrees/<name> <script>`, "
            f"`worktrees/<name>/node_modules/.bin/<tool> <args>`. "
            f"(Read/Edit/Write file paths are the opposite — those MUST be absolute.)"
        )
    elif main_repo in cmd:
        message = (
            f"Drop the absolute path to the main repo (`{main_repo}`). "
            f"Your cwd is already the repo root, so use bare commands like "
            f"`git status` / `cat package.json` / `ls docs/`, not "
            f"`git -C {main_repo} status` / `cat {main_repo}/package.json`. "
            f"Absolute paths bypass the committed Bash allowlist (`*` matches "
            f"at the literal pattern position) and force re-prompts. For "
            f"worktrees, use the relative `worktrees/<name>/...` forms. "
            f"(Read/Edit/Write file paths are the opposite — those MUST be absolute.)"
        )
    else:
        return 0

    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": message,
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
