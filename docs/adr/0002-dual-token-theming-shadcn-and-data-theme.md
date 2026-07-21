# ADR-0002: Dual-token theming — OpenPortfolio `--op-*` alongside shadcn tokens, one `data-theme` dark signal

- **Status:** Accepted
- **Date:** 2026-07-21
- **Trigger:** WS4 frontend-foundation plan, Task 10 (shadcn/ui setup). The plan's Task 4 theme system and shadcn/ui's theme system were unaligned; a naive integration left dark mode inconsistent and light-mode tokens undefined.
- **Commit(s):** `46baf95` feat(frontend): shadcn/ui setup + primitives with dual-token theme; `88e4e68` fix(frontend): namespace OpenPortfolio tokens as --op-* to survive Tailwind tree-shaking
- **Related:** [specs/2026-05-19-frontend-foundation-design.md](../specs/2026-05-19-frontend-foundation-design.md) (D5 theme resolution), [ADR-0001](0001-worktree-convention-and-permission-model.md)

## Context

The spec (D5) chose an explicit theme override — `system | light | dark` — applied by writing a `data-theme` **attribute** to `<html>` (removed for `system`, so the CSS `@media (prefers-color-scheme: dark)` rule handles it). Task 4 defined OpenPortfolio's palette as Tailwind `@theme` tokens named `--color-bg/-fg/-muted/-accent/-loss/-gain/-border`.

shadcn/ui components ship with a *different* convention: they key dark styles off a `.dark` **class** and reference their own token vocabulary (`bg-background`, `text-muted-foreground`, `border`, `ring`, …). Integrating shadcn naively produced two concrete defects:

1. **Split dark mode.** shadcn's `.dark`-keyed styles never activated under our `data-theme` attribute, so in dark mode the sidebar/settings (inline `var(--color-*)`) went dark while shadcn's `Table`/`Skeleton` stayed light — failing the acceptance criterion "Click Dark → background goes dark."
2. **Tree-shaken light tokens.** shadcn's `@theme inline` claimed the `muted`/`accent`/`border` utility names, so our `@theme --color-muted`/`--color-border` had no consumer and Tailwind v4 tree-shook their **light** values out of `:root`. Inline `var(--color-muted)`/`var(--color-border)` (used by the Accounts/Settings/Sidebar/error-boundary components) were then **undefined in light mode** — muted text rendered as body text, borders fell back to `currentColor`. Confirmed by inspecting the compiled CSS: only the raw-block dark values survived; the light `@theme` values were absent.

## Alternatives considered

- **A)** Keep both systems on their native signals (shadcn `.dark`, app `data-theme`) — rejected: two dark signals can't be driven from one control; dark mode stays split.
- **B)** Migrate fully to shadcn's token names, dropping `--color-*` — rejected (user call): larger churn, rewrites Task 4 CSS plus every inline `var(--color-*)` in later tasks; the spec deliberately owns an OpenPortfolio palette (incl. `--gain`/`--loss` shadcn lacks).
- **C)** Dual tokens, one signal (chosen).

## Decision

Two token vocabularies, one dark signal:

- OpenPortfolio's semantic tokens live in an **`--op-*`** namespace (`--op-bg/-fg/-muted/-accent/-loss/-gain/-border`) as **plain `:root` custom properties**, not `@theme` entries — so Tailwind v4 never tree-shakes them and they always resolve for inline `style={{ var(--op-*) }}`. They deliberately avoid the `--color-*` Tailwind namespace to preclude collision with shadcn.
- shadcn's tokens (`--background`, `--muted`, `--ring`, …) are defined for light/dark and exposed to Tailwind via `@theme inline` so `bg-background`, `text-muted-foreground`, `border-border`, etc. are generated.
- Both flip on the **same signal**. A Tailwind v4 `@custom-variant dark` and every dark token block use the identical two selectors: `[data-theme='dark']` (explicit) and `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }` (system). ThemeProvider sets/removes `data-theme`; no JS media watcher is needed (removed dead code — the CSS handles live OS-follow).

All values live in [src/frontend/styles.css](../../src/frontend/styles.css).

## Consequences

- Component authors use `var(--op-*)` for OpenPortfolio-specific inline styling and shadcn utility classes for shadcn primitives; the two never collide by name.
- Every future frontend task must use `var(--op-*)`, not `var(--color-*)` — the `--color-*` app namespace no longer exists. (Applied across Tasks 11/12/14.)
- `--op-gain`/`--op-loss` are defined now for WS7 gain/loss coloring though unused in WS4.
- Adding a shadcn component needs no CSS change; its tokens already exist and flip correctly.

## Verification

- Compiled-CSS probe build confirmed all seven `--op-*` tokens emit in `:root` with both light and dark values (for bg/fg/muted/border), and that shadcn utilities still resolve to shadcn tokens (`.text-muted-foreground{color:var(--muted-foreground)}`).
- `grep 'var(--color-'` over `src/frontend` returns zero matches (enforced per task).
- Full visual light/dark verification across the app shell is the WS4 acceptance step (browser).
