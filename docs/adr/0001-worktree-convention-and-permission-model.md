# ADR-0001: Worktree convention and Claude Code permission model

- **Status:** Accepted
- **Date:** 2026-05-18
- **Trigger:** Setting up a worktree workflow that's host-independent and a Claude Code permission allowlist safe enough to commit to the shared repo. Worktrees were initially rejected on 2026-05-15 because npm's full per-tree duplication (~470 packages) made each worktree expensive; the switch to pnpm on 2026-05-18 (commit 46752ac) collapsed that cost via content-addressed symlink installs and re-opened the question.
- **Commit(s):** This ADR's landing commit on `chore/bootstrap-conventions`. The pnpm prerequisite is commit 46752ac.
- **Related:** —

## Context

Two goals colliding:

1. **Use worktrees regularly** — isolated-branch work pays off when a detour interleaves with the original plan, or when a long-running dev server needs to coexist with editing on another branch. The local-first architecture (backend + frontend + MCP server) makes parallel runs especially useful.
2. **Host-independent and future-contributor-friendly** — paths like `/Users/nick/dev/projects/OpenPortfolio-feature-x/` are user-specific. The repo is open source (MIT) and PRs are accepted; committed settings shouldn't bake in `/Users/nick/...`.

A naive worktree setup runs into Claude Code permission friction the moment the worktree lives at a different path: the committed allowlist is keyed to relative path patterns (e.g. `Bash(pnpm test*)` works because cwd is the repo root), so commands in the worktree re-prompt every time. Bypassing that with a wide pattern like `Bash(cd <prefix>* && *)` works but allows arbitrary command chaining (`cd worktrees/foo && rm -rf $HOME` matches the same pattern as `cd worktrees/foo && pnpm test`), which is an unacceptable security boundary even for a single-contributor repo with future PR traffic.

## Alternatives considered

- **A) Worktrees outside the repo** at e.g. `~/dev/OpenPortfolio-<branch>/`. Reject: paths bake `/Users/<user>` into anything that references them; not host-independent.
- **B) Wide allow patterns** like `Bash(pnpm *)` and `Bash(cd worktrees/* && *)`. Reject: greedy glob matching across shell metachars means `pnpm test && rm -rf ~` matches `pnpm *`, and `cd worktrees/foo && rm -rf` matches `cd worktrees/* && *`. Unacceptable security boundary.
- **C) Skip worktrees entirely; use branch-switching only.** Was the chosen path 2026-05-15 → 2026-05-18 under npm. Worked but blocked parallel-run scenarios (dev server on one branch, edits on another).
- **D) Worktrees inside the repo at `worktrees/<branch>/`, gitignored, with narrow per-subcommand allow patterns and cwd-free command forms, enabled by the pnpm switch.** Chosen.

## Decision

### 1. Worktree placement

Worktrees live inside the repo at `worktrees/<branch-slug>/`. The `worktrees/` directory is gitignored so it doesn't appear as untracked content in the main checkout. This makes paths relative to the project root and identical across hosts.

### 2. Permission file split

- `.claude/settings.json` — **committed**, host-neutral. Contains the allowlist, deny list, hooks, and `additionalDirectories`.
- `.claude/settings.local.json` — **gitignored**, per-user overrides (currently used for an `env.PATH` that includes the local nvm bin).

The worktree helper (`scripts/worktree-add.sh`) copies `.claude/settings.local.json` into the new tree on creation, since gitignored files don't follow into worktrees automatically.

### 3. Allow-pattern shape

The allowlist is **layered** by command class:

- **Build/test/run tools** (pnpm, git, node, npx): enumerate per-subcommand. `Bash(pnpm test*)`, `Bash(git status*)`, etc. — never `Bash(pnpm*)` or `Bash(git*)`. Excludes by omission: `pnpm add`, `pnpm remove`, `pnpm update`, `pnpm dlx`, `pnpm publish`, `git push --force`, `git reset --hard` all prompt or are denied.
- **Read-only inspection tools** (grep, rg, ls, head, tail, wc, diff, file, stat, jq, ps, df, du, ...): wide patterns are acceptable because these have no destructive forms.
- **Dual-use tools** (find, sed, awk): narrow patterns (`Bash(find * -name *)`, `Bash(sed -n *)`) plus deny rules for destructive forms (`-delete`, `-exec`, `sed -i`, `awk*system*`).
- **Python**: committed scripts only. `Bash(python3 scripts/*)` is allowed; inline `python3 -c "..."` prompts. Reason: inline-Python deny lists are defeatable (e.g. `__import__('os').system(...)`); any helper that runs without a prompt should be reviewable code in `scripts/`.

### 4. Cwd-free worktree forms instead of `cd` chains

Claude Code's matcher prompts on every `cd <relative-path> && <external-command>` chain regardless of allowlist — it's a shell-state-changing-chain guard, not a missing pattern. So the worktree allowlist uses **cwd-free forms**:

- `Bash(git -C worktrees/* <subcommand>*)` instead of `Bash(cd worktrees/* && git <subcommand>*)`.
- `Bash(pnpm -C worktrees/* <script>*)` for each script (test, typecheck, lint, format, build, dev, db:generate, install).

This pairs with the slug-flattening rule: branch `feat/foo` lives at `worktrees/feat-foo/` (not `worktrees/feat/foo/`) because `*` in Bash patterns does NOT span `/`. The branch name itself keeps the slash; only the directory slug is flat. `scripts/worktree-add.sh` does the flattening.

### 5. Deny patterns block destructive shell shapes

Layer 2 of the defense. Path-agnostic; trips on shape regardless of cwd:

```
Bash(*&& rm -rf*), Bash(*; rm -rf*),
Bash(*| sh*), Bash(*| bash*),
Bash(*sudo *), Bash(*curl * | *), Bash(*wget * | *),
Bash(*git push --force*), Bash(*git push -f *),
Bash(*git reset --hard *), Bash(*git clean -fd*),
Bash(*--no-verify*), Bash(*chmod -R *),
Bash(*find * -delete*), Bash(*find * -exec*),
Bash(*find * -execdir*), Bash(*find * -ok*),
Bash(*sed -i*), Bash(*sed --in-place*),
Bash(*awk*system*), Bash(*awk*print *> *),
Bash(*> /dev/sd*), Bash(*dd if=*of=/dev/*),
Bash(*npm publish*), Bash(*pnpm publish*),
Bash(*rm -rf node_modules*)
```

Deny takes precedence over allow. So even if greedy glob lets `pnpm test && rm -rf $HOME` match `Bash(pnpm test*)`, the `Bash(*&& rm -rf*)` deny pattern wins. The deny list is **defense-in-depth, not the primary line** — incomplete by construction.

The publish denies are belt-and-suspenders on top of `"private": true` in [package.json](../../package.json), which is the actual barrier (npm/pnpm refuse to publish private packages regardless of what's typed).

### 6. PreToolUse hook for absolute repo paths

`scripts/check_worktree_paths.py` (registered in `settings.json` under `hooks.PreToolUse`) catches Bash calls that contain the absolute path to the repo root or a worktree, and denies them with a message pointing at the relative form. Without this, Claude occasionally types `cat /Users/nick/dev/projects/OpenPortfolio/package.json` instead of `cat package.json`, and every such call costs a re-prompt because absolute paths bypass `*` in allow patterns.

### 7. High-risk operations use isolated subagents

For running unreviewed contributor code, evaluating an external PR, or any operation whose blast radius matters, use `Agent(isolation: "worktree", ...)`. The subagent operates in an isolated temporary worktree with a constrained per-task permission scope, and the worktree is destroyed on exit.

## Consequences

**Enables:**

- Parallel worktrees with near-zero install cost (pnpm content-addressed store + symlinks).
- Routine inspection (grep, find, git status, pnpm test, pnpm typecheck) doesn't prompt — friction is reserved for deliberate acts.
- The committed allowlist is reviewable: a security-minded reviewer can read `.claude/settings.json` and see exactly which commands run without prompting.
- Mutation outside the known toolset (mv, cp, mkdir, chmod, curl, ...) prompts — which is the right friction profile.

**Constrains future work:**

- Adding a new allowed subcommand requires a `settings.json` edit. ~30 seconds of friction per new tool, intentional.
- Inline Python prompts; analysis helpers must be committed to `scripts/`.
- The deny list is incomplete by construction. A sufficiently clever attacker (or prompt injection) within an allowed-tool surface can find ways to do harm. Mitigation: review branches before running tools on them; subagent isolation for unreviewed code.
- Worktree creation requires a `pnpm install` step (~5 s with a warm store). Documented in the helper's output.

**Specific exclusions worth naming:**

- `pnpm add`, `pnpm remove`, `pnpm update`, `pnpm dlx` — prompt.
- `pnpm publish`, `npm publish` — denied (plus `private: true` in package.json).
- `git push --force`, `git push -f`, `git reset --hard`, `git clean -fd`, `--no-verify` — denied.
- `sudo` anywhere — denied.
- Pipe-to-shell shapes (`curl | sh`) — denied.

## Verification

- `pnpm worktree test1` creates `worktrees/test1/`, copies `.claude/settings.local.json` if present, and prints the next-step `pnpm install` reminder.
- `git status` from the main checkout shows no `worktrees/test1/` content (gitignored).
- A test command that should prompt (`pnpm add lodash`) does prompt; a routine command (`pnpm test`) does not.
- The PreToolUse hook fires when a Bash command contains the absolute repo root path, denying with a message pointing at the relative form.
- `pnpm worktree-rm test1` cleans up without leaving stale entries in `git worktree list`.
