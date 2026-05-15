# OpenPortfolio Workstream

This document is the working contract between the project and any contributor (human or AI agent). It defines the invariants that must hold, the architecture, and the work that's outstanding.

## How to use this document

Read the **Invariants** section first and re-read it whenever you're uncertain. The invariants are non-negotiable; the phase ordering below is suggestive but not strict — if you find that dependencies require reordering, document the decision and proceed.

Pick up work from the **Active Phases** section. Each phase has a definition of done. Don't expand scope mid-phase; if a related improvement comes up, add it as a follow-up task and surface it at review time.

## Project mission

OpenPortfolio is a local-first portfolio tracker that prioritizes honest accounting over engagement. The product behaviors that matter most:

- Real returns net of inflation
- Bear cases shown alongside bull cases
- Sources cited for any AI-generated analysis
- No buy/sell recommendations under any circumstance
- Local data, no telemetry, no cloud

Code that conflicts with these behaviors gets rejected at review time, regardless of how convenient or well-engineered it is.

## Architecture

Three processes, sharing a single SQLite database in WAL mode:

1. **Electron main process** — application shell, window management, file system access, IPC routing.
2. **Hono backend (Node)** — REST API, financial calculations, database access, business logic. The only writer to the database.
3. **MCP server (Node)** — exposes read-only portfolio data to Claude Desktop and other MCP clients. Read-only by architecture, not by configuration.

Frontend is React 18 with TypeScript, served by Vite in development and bundled into the Electron renderer in production.

**The model-vs-code split is the cornerstone architectural decision.** AI never touches numbers directly. AI parses natural language, chooses which queries to run, and explains results in words. Calculations are done by audited deterministic code. Anywhere this boundary is ambiguous, fix the design before writing the code.

## Invariants

These rules hold across the entire codebase. They are not phase-dependent and they do not have exceptions.

### Financial integrity

- **Money is integer cents.** No floats, ever. The type system enforces this where possible; reviewers enforce it everywhere else.
- **Soft delete only.** Records are marked deleted, not removed. Every table that holds user data has a nullable `deleted_at` timestamp.
- **Drizzle migrations only.** No `ALTER TABLE` outside the migration system. The migration log is the source of truth for schema.
- **Real returns are net of inflation.** Nominal returns are computed and available but not the default display.

### AI behavior

- **No buy/sell recommendations.** Not at the LLM level, not at the UI level, not in tooltips, not in error messages. Enforced by system prompts AND by code review.
- **Bear cases required.** Any AI feature that surfaces analysis must include counter-arguments or risks.
- **Sources required.** AI features must cite the data they used to reach conclusions, ideally with a link to the underlying record.
- **System prompts are versioned.** Prompts live in `src/prompts/` and are reviewed like any other code. Inline prompt strings in feature code are a code smell.

### Code quality

- **Test coverage targets:** 95%+ on financial calculation modules, 90%+ on shared utilities, 80%+ on services and routes.
- **TypeScript strict mode.** No `any` without a comment explaining why and a linked issue to remove it.
- **No silent failures.** Errors propagate or are logged with context. Empty `catch` blocks are a code smell.

### Privacy

- **No telemetry.** Not error reporting, not usage analytics, not crash logs sent anywhere.
- **No outbound network calls** except to explicitly user-configured services (Ollama, price data sources the user opted into during setup).

## Active Phases

The project is structured in 13 phases. Phases 0–8 are complete on `main`. The phases below are the outstanding work.

**Note:** The phase descriptions below are reconstructions and may need refinement to match the actual intended scope. Treat them as a working draft; adjust as you discover the real shape of each phase.

### Phase 9 — Tile-based dashboard

Implement a configurable dashboard where users can arrange information tiles. Built on dnd-kit for accessible drag-and-drop.

Tasks:
- Tile component framework with a registered set of tile types (positions table, allocation chart, returns timeline, drawdown summary, individual position card, etc.)
- Layout state stored in SQLite with a migration
- dnd-kit integration for rearrangement and resizing
- Tile-level configuration (e.g., a "real vs nominal" toggle on a returns tile)
- Layout persistence and reset-to-default

Definition of done: a user can add tiles, rearrange them, configure them per-tile, and the layout persists across restarts.

### Phase 10 — Electron shell

Move the developer experience from "Vite + standalone backend in two terminals" to a unified Electron app.

Tasks:
- Electron main process bootstrap with single-window management
- IPC layer between renderer and backend (the backend continues to run as a separate Node process for testability)
- Application menus and keyboard shortcuts
- Single-instance enforcement
- Data directory selection on first launch
- Auto-restart of backend on crash, with a visible status indicator in the UI

Definition of done: `npm run dist` produces a packaged application that launches a window and connects to the local backend cleanly. No terminal windows required.

### Phase 11 — Ollama integration

Local AI inference layer. No cloud calls. Ollama is the only AI backend supported initially.

Tasks:
- Ollama client wrapper with model availability checks
- Model lifecycle management (warm/cold, keep-alive tuning)
- Prompt template system loading from `src/prompts/` with versioning
- Token usage logging (local only, for the user's own visibility)
- Graceful degradation with clear messaging when Ollama is not running

Definition of done: a user with Ollama installed and a supported model pulled can ask natural-language questions about their portfolio and receive grounded answers that include citations and bear cases.

### Phase 12 — MCP server

Expose read-only portfolio data to Claude Desktop and other MCP-compatible clients.

Tasks:
- MCP server process, separate from the backend, sharing SQLite via WAL mode
- Tool definitions for portfolio queries (positions, returns, drawdowns, transactions)
- Read-only enforcement at the connection layer — the server opens the database in read-only mode, not just guarding queries
- Documentation of available tools for the user (which tools exist, what they return)

Definition of done: a user with Claude Desktop configured to use the OpenPortfolio MCP server can ask Claude about their portfolio and receive structured data answers without OpenPortfolio's UI being open.

### Phase 13 — Polish and distribution

Final phase before public release.

Tasks:
- macOS, Windows, and Linux builds via electron-builder
- Code signing and notarization where required (macOS, Windows)
- First-run experience and onboarding
- User-facing documentation in `docs/`
- README finalization including screenshots and a demo video
- Public repo checklist: no secrets, no hardcoded local paths, license headers where appropriate

Definition of done: someone can download a release artifact, install it, and use the app without reading source code.

## Working agreement for AI agents

When picking up work:

1. **Read the invariants first.** Every time. They override convenience and they override your prior context.
2. **Confirm scope before writing code.** If the task is large, propose a plan and wait for approval.
3. **Tests before features, especially for financial calculations.** The coverage target is not optional.
4. **Cite design decisions in comments** when the rationale isn't obvious from the code. A future agent (or human) will need to know why.
5. **Surface ambiguity, don't paper over it.** If a task can be interpreted multiple ways, ask. Picking a direction silently creates rework.
6. **No new dependencies without justification.** The dependency tree is intentionally small. Each addition needs a reason that's stronger than "convenient."
7. **Don't refactor outside the task you were given.** If you see something that needs cleanup, add it to a follow-up list. Mid-task refactoring is how PRs balloon.

## Out of scope

These are not "out of scope for now." They are out of scope, full stop:

- Cloud sync of any kind
- Multi-user features
- Buy/sell recommendations
- Tax filing or generation of tax documents (data export for tax software is fine; tax claims from OpenPortfolio are not)
- Real-time tick data (end-of-day pricing is the design target)

These are out of scope for now but may be reconsidered later:

- Mobile apps
- Web hosting of OpenPortfolio as a service
- Broker API integration for automatic transaction import
