# Architecture Decision Records

Each ADR captures one structural decision. ADRs complement (not replace)
narrative decision docs and implementation plans. The split:

- **ADR (`docs/adr/NNNN-slug.md`)** — one decision, one file. Use for
  structural choices where a future reader will ask "*why this and not that?*"
  Status, context, alternatives considered, decision, consequences. ~30–80
  lines each.
- **Spec (`docs/specs/<topic>.md`)** — design doc for a multi-fork problem.
  Lays out alternatives, ends with a "Decisions and rationale" section once
  the user picks one.
- **Commit message** — mechanical or one-off choices: rationale lives next
  to the change. See [`~/.claude/skills/commit-style/SKILL.md`].
- **Inline comment** — magic numbers, surprising branch orders, hidden
  constraints.

If you're about to ask the user "X vs Y, I lean X, your call?", their answer
is an ADR.

## Conventions

- **Numbering:** zero-padded 4 digits (`0001-...`). Pick the next free number.
- **Slug:** kebab-case, ≤ 8 words, what-not-why.
- **Status:** `Proposed` → `Accepted` → `Superseded by ADR-NNNN`. Never
  delete an ADR; mark superseded.
- **Backlinks:** every ADR lists the prompting plan / commit / narrative
  doc.
- **Template:** see [`template.md`](template.md).
- **Length:** if the ADR runs past ~150 lines, the *decision* probably
  belongs in a narrative doc with a thin ADR pointing at it.
