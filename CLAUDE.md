# Project conventions

OpenPortfolio is a local-first portfolio tracker. The domain-level engineering
principles (integer cents for money, soft-delete only, Drizzle migrations only,
test-coverage targets, AI-rules-as-code) live in [README.md](README.md) under
"Engineering principles" — those are non-negotiable and apply to every change.
This file covers the operational conventions: testing, decision-recording,
worktrees, and permissions.

## Testing

Canonical commands (all run from the repo root):

- Full suite: `pnpm test`
- Single file: `pnpm exec vitest run path/to/file.test.ts`
- Watch mode: `pnpm test:watch`
- Coverage: `pnpm test:coverage`
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`
- Format: `pnpm format` (writes) / `pnpm format:check` (reports only)

Tests use **vitest**. Property-based tests use **fast-check** (already a dev
dep). Money is integer cents everywhere — no float-based money in tests
either.

## Documenting decisions

When making a non-trivial design or implementation decision, document the
*alternatives considered* and the *rationale* — not just the choice. A
decision without rejected alternatives isn't a decision; it's a description,
and a future reader can't tell whether it still applies when constraints
change.

Four formats, used at different phases:

- **Brainstorm / spec phase** (design docs in `docs/specs/<topic>.md`):
  present each fork as 2–3 labeled alternatives (A / B / C) with trade-offs
  and a recommendation, get the user's choice, then record a "Decisions and
  rationale" section in the spec.
- **Implementation phase**: structural choices that make a future reader ask
  "why this and not that?" go in `docs/adr/NNNN-<slug>.md` per
  [docs/adr/README.md](docs/adr/README.md).
- **Commit message** — mechanical or one-off choices: the rationale lives
  next to the change. See [~/.claude/skills/commit-style/SKILL.md] for the
  Conventional-Commits-with-rationale style this repo uses.
- **Inline comment** — magic numbers, surprising branch orders, hidden
  constraints: lives in the code.

If you're about to ask the user "X vs Y, I lean X, your call?", their answer
is a documented decision, not a passing remark. Capture it.

## Branches

All non-trivial work happens on a type-prefixed branch (`feat/`, `fix/`,
`chore/`, `docs/`, `refactor/`, `test/`) — never directly on `main`. Match
the branch type to the dominant commit type. Merge to `main` with
fast-forward (`git merge --ff-only`) to preserve per-commit rationale.
Switch to `--no-ff` or squash only if explicitly requested.

## Worktrees

Worktrees live inside the repo at `worktrees/<branch-slug>/` (gitignored).
Use the helper:

    pnpm worktree <branch> [<base>]      # create
    pnpm worktree-rm <branch>            # remove (must be clean)

Or the raw form:

    git worktree add worktrees/<slug> -b <branch> [<base>]

The helper handles slug-flattening and copies `.claude/settings.local.json`
into the new tree. After creation, `cd worktrees/<slug> && pnpm install` —
pnpm's content-addressed store makes this near-free via symlinks.

**Branch names with `/` get flattened in the directory slug.** Branch
`feat/foo` lives at `worktrees/feat-foo/`, not `worktrees/feat/foo/`. The
branch name keeps its slashes; only the directory slug is flat. Flattening
keeps each worktree a single path segment under `worktrees/`, so the relative
Bash paths and the `check_worktree_paths.py` hook messages stay unambiguous.

### Working inside a worktree from Claude Code

These rules apply to **both the parent session and any dispatched subagent**:

1. **Use cwd-free command forms.** Don't `cd` into the worktree. Claude
   Code's matcher prompts on every `cd <relative-path> && <external-command>`
   chain regardless of allowlist (it's a shell-state-changing-chain guard).
2. **Use relative paths from the repo root in Bash, not absolute.**
   `worktrees/<name>/...` matches the committed allowlist; absolute paths
   bypass it. The `scripts/check_worktree_paths.py` PreToolUse hook catches
   absolute-path mistakes and tells you the relative form. (Read / Edit /
   Write file paths are the opposite — those MUST be absolute.)

The auto-allowed forms:

- **Git:** `git -C worktrees/<name> <subcommand> <args>` — covered by the
  single `Bash(git -C worktrees/*)` rule (any subcommand). Destructive shapes
  like `reset --hard` and `push --force` are still blocked by the deny list,
  which uses literal-substring patterns that fire regardless of allow.
- **Pnpm scripts:** `pnpm -C worktrees/<name> <script> <args>` — covered by
  the single `Bash(pnpm -C worktrees/*)` rule (runs the target tree's
  `package.json` script). Note this also auto-allows `pnpm -C worktrees/<name>
  add` / `remove` / `update` / `dlx`; the deliberate-prompt-on-`add`
  convention only applies in the main checkout.
- **Built tools:** `worktrees/<name>/node_modules/.bin/<tool> <args>` if you
  need a direct invocation; usually `pnpm -C worktrees/<name> exec <tool>` is
  cleaner.
- **Read / Edit / Write:** always **absolute** paths under
  `worktrees/<name>/` so edits can't leak to main. Verify with
  `git -C worktrees/<name> status` after a batch of edits.

## Subagent model selection

For subagent-dispatched implementation tasks against the plans in `docs/superpowers/plans/`, **default to Sonnet** (`model: "sonnet"` on the `Agent` call). The orchestrator stays on Opus and does the thinking; the subagent does the typing. Sonnet 4.6 is meaningfully cheaper and faster and handles well-scoped mechanical work fine.

Plans are eligible for Sonnet when they pin file paths, function/type signatures, task ordering, and behavior specified numerically — i.e. the subagent is transcribing decisions, not making them.

**Escalate to Opus when:**

- The plan task body says "decide between X and Y", "design the strategy for…", or describes behavior without pinning signatures.
- The task is a multi-file refactor where the subagent has to make structural choices mid-task.
- The plan is missing — the subagent would have to do design work, not implementation.

Pre-flight check: skim the specific task body before dispatching. "Add this function with this signature, here's the test" → Sonnet. "Build the generator that produces…" → Opus.

## Permissions and security

The committed `.claude/settings.json` is the shared allowlist. It's
deliberately narrow: per-subcommand patterns for build/test/git tools, wide
read-only inspection, and a deny list for destructive shell shapes. Per-user
overrides go in `.claude/settings.local.json` (gitignored).

**How the matcher works** (verified empirically):

- Chains are split on `&&` and each segment is matched independently. Chain
  patterns of the form `Bash(X && Y)` are dead code — never matched as a
  single pattern.
- **Exception:** chains where segment 1 is `cd <relative-path>` and segment
  2 is an external command **always prompt**, regardless of allowlist. Use
  cwd-free forms instead.
- **Only a trailing `*` matches reliably.** A `*` at the end of a pattern
  spans everything after the literal prefix — spaces **and** `/`. So
  `Bash(git -C worktrees/*)` matches `git -C worktrees/feat-foo log --oneline`,
  and `Bash(ls*)` matches `ls -d worktrees/*/`. But a `*` in the **middle**
  followed by a literal segment does **not** match: `Bash(git -C worktrees/*
  log*)` fails against that same command (the ` log*` after the star is never
  satisfied, even though the star only needs to match a flat slug with no `/`).
  Structure every rule as `literal-prefix + trailing *`, never
  `prefix + * + literal`. Rules still written the broken way in this file —
  `find * -name *`, `find * -type *`, `sqlite3 *.db *`, `sqlite3 *.sqlite *` —
  are dead and will prompt until reshaped (or removed).
- Deny patterns of the form `Bash(*<literal>*)` are pure substring-contains
  and work fine (e.g. `Bash(*git reset --hard *)`). A deny with a `*` in the
  middle of the literal (`Bash(*dd if=*of=/dev/*)`) has the same dead-middle
  problem — don't rely on those shapes.
- **Settings are loaded once at session start** — restart Claude Code after
  editing `settings.json` or `settings.local.json`.

**Excluded by omission (will prompt):** `pnpm add`, `pnpm remove`,
`pnpm update`, `pnpm dlx`. Adding a dependency is a deliberate act and
should get an explicit prompt. **Main checkout only** — inside a worktree the
broad `Bash(pnpm -C worktrees/*)` rule auto-allows these; the prompt boundary
does not extend into worktrees.

**Denied (will not run):** `pnpm publish`, `npm publish`, `git push --force`,
`git reset --hard`, `sudo`, pipe-to-shell (`curl | sh`), `--no-verify`,
`rm -rf node_modules`, and various destructive `find`/`sed`/`awk` shapes.
The package is also `"private": true` in `package.json`, which is the real
boundary against publish — the deny line is defense-in-depth on top.

Inline `python3 -c "..."` prompts by default. Helpers go in `scripts/` and
are invoked as `python3 scripts/<name>.py`.
