# ADR-0003: Broaden worktree Bash permission rules to a single trailing wildcard

- **Status:** Accepted
- **Date:** 2026-07-21
- **Trigger:** Re-prompts on commands the allowlist appeared to cover; empirical
  reproduction of the permission-matcher's actual wildcard semantics.
- **Commit(s):** _pending_
- **Related:** [ADR-0001](0001-worktree-convention-and-permission-model.md),
  `.claude/settings.json`, "Permissions and security" in [CLAUDE.md](../../CLAUDE.md)

## Context

The committed allowlist carried per-subcommand worktree rules of the form
`Bash(git -C worktrees/* <subcommand>*)` and `Bash(pnpm -C worktrees/* <script>*)`
(≈36 lines total). These prompted instead of auto-approving. Reproduced in
session:

- `git -C worktrees/feat-tile-dashboard log --oneline -1` → prompted, despite
  `Bash(git -C worktrees/* log*)`.
- `pnpm -C worktrees/feat-tile-dashboard exec vitest run <path>` → prompted,
  despite `Bash(pnpm -C worktrees/* exec*)`.

The rationale previously recorded in CLAUDE.md ("`*` does NOT span `/`") does
**not** explain this: in `worktrees/* log*` the star only has to match the flat
slug `feat-tile-dashboard`, which contains no `/`. The real matcher rule,
established empirically:

- A **trailing** `*` matches everything after the literal prefix, spanning
  spaces **and** `/`. Evidence: `ls -d worktrees/*/` auto-ran under `Bash(ls*)`
  (its wildcard region contains both).
- A `*` in the **middle** of a pattern followed by a literal segment (the
  ` log*` / ` exec*` after the star) does **not** match at all.

So `prefix + * + literal` is structurally dead; only `literal-prefix + trailing *`
works. Settings load once per session, so fixes can only be validated after a
restart — this argues for one robust structure over guess-and-restart cycles.

## Alternatives considered

- **A) Broaden per tool** — replace each worktree block with one trailing-wildcard
  rule: `Bash(git -C worktrees/*)`, `Bash(pnpm -C worktrees/*)`. Simple, scalable
  to new worktrees, ~36 dead lines → 2 working ones. **Chosen.**
- **B) Broaden git, generate pnpm** — broaden git as in A, but have the
  `pnpm worktree` helper append literal per-script pnpm rules to
  `settings.local.json` per worktree, to keep `pnpm add` prompting. Rejected:
  more machinery, per-worktree backfill, for a low-severity prompt boundary.
- **C) Generate all rules per worktree** — helper writes literal per-subcommand
  git+pnpm rules per worktree. Rejected: most machinery and most lines per
  worktree; the narrowness it buys is already covered by the deny list.

## Decision

The two worktree blocks in `.claude/settings.json` collapse to exactly:

```json
"Bash(git -C worktrees/*)",
"Bash(pnpm -C worktrees/*)",
```

Both are `literal-prefix + trailing *`, the only reliably-matching shape. They
auto-cover every current and future flat-slug worktree. The main-checkout git
rules stay per-subcommand (they already work — trailing `*`, no middle
wildcard). Destructive shapes remain blocked by the deny list, whose
`Bash(*<literal>*)` substring-contains patterns (`*git reset --hard *`,
`*git push --force*`, `*rm -rf*`) fire regardless of allow.

## Consequences

- **Enables:** worktree git/pnpm commands auto-approve, including file-path
  arguments containing `/` (e.g. `pnpm -C worktrees/x exec vitest run src/a/b.test.ts`).
- **Widens (accepted):** any git subcommand and any pnpm script — including
  `pnpm -C worktrees/x add|remove|update|dlx` — auto-run in worktrees. The
  "deliberate prompt on `add`" convention now applies to the **main checkout
  only**. `pnpm publish` is still guarded by `"private": true` in package.json
  (the real boundary) plus the `*pnpm publish*` deny.
- **Gap noted, not relied upon:** the deny `*pnpm publish*` does not match the
  `-C` form (`pnpm -C worktrees/x publish` has text between `pnpm` and
  `publish`); `"private": true` is what actually prevents publish.
- **Blast radius:** worktrees only. `main` permissions unchanged.

## Verification

- `python3 -c "import json; json.load(open('.claude/settings.json'))"` — file
  remains valid JSON.
- After a Claude Code restart (settings load once at startup):
  `git -C worktrees/<name> log --oneline -1` and
  `pnpm -C worktrees/<name> exec vitest run <path>` auto-approve with no prompt.
- Deny still fires: `git -C worktrees/<name> reset --hard HEAD~1` is blocked.

## Note — other dead rules (out of scope here)

The same middle-wildcard limitation kills `find * -name *`, `find * -type *`,
`find * -path *`, `sqlite3 *.db *`, and `sqlite3 *.sqlite *`. They fail safe
(they prompt). Reshaping or removing them is deferred to a follow-up.
