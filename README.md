# OpenPortfolio

A local-first portfolio tracker built around honesty. Real returns net of inflation, bear cases beside bull cases, sources cited for any analysis, and no buy/sell recommendations — not as a feature toggle, but as a design discipline.

OpenPortfolio is for the kind of investor who wants to see their portfolio clearly, including the parts that are uncomfortable to look at, and who wants slower decisions because of it.

## Why this exists

Most portfolio trackers optimize for engagement. Big green numbers when markets are up, push notifications when stocks move, AI features that confidently tell you what to do next. That UI design isn't an accident — it's what keeps you opening the app. It's also what gets people to panic-sell in March 2020 and FOMO-buy at the top.

OpenPortfolio takes a different approach. It's designed as a behavioral tool, not an alpha-generation tool. Specifically:

- **Real returns, not nominal.** A portfolio "up 8%" doesn't mean much if inflation was 6%. OpenPortfolio shows returns net of CPI by default, because that's the number that affects your life.
- **Bear cases alongside bull cases.** When AI features generate analysis — explaining a drawdown, summarizing a position — they always show counter-arguments and cite sources. Confidence is suspicious; balanced reasoning is what you want when you're nervous.
- **No buy/sell recommendations, ever.** OpenPortfolio will help you understand your portfolio. It won't tell you what to do with it. That rule is enforced in code review, not just in copy.
- **Local-first.** Your portfolio data lives on your machine. No cloud sync, no telemetry, no third party that owns the information. The database is a regular SQLite file you can open with any tool that reads SQLite.

## What's inside

OpenPortfolio is a desktop application with three main components:

1. **A React frontend** for viewing your portfolio — positions, returns, drawdowns, and a configurable tile-based dashboard you can rearrange.
2. **A local backend** that owns all financial calculations. Money is represented as integer cents everywhere — never floats — because floats lie about money in ways that compound over years.
3. **An MCP server** that exposes read-only access to your portfolio data for Claude Desktop and other MCP-compatible AI clients. The server can answer questions about your portfolio but cannot modify anything. AI behavior rules live in versioned system prompts so the guardrails are auditable.

The architectural cornerstone: **the model identifies and explains; deterministic code computes.** AI never touches numbers directly. When you ask "what's my real return on AAPL since I bought it," the AI parses the question and chooses which numbers to fetch, but the math is done by audited code with tests. This separation is the only honest way to use AI in financial software.

## Tech stack

- **TypeScript** throughout — frontend, backend, MCP server, shared types
- **React 18** for the frontend
- **Electron** for desktop packaging
- **Hono** for the backend HTTP layer — lightweight, type-safe
- **Drizzle ORM** for the database layer — compile-time type checking, simple migrations
- **SQLite** in WAL mode, so the MCP server can read while the backend writes
- **Ollama** for local AI inference (no data leaves your machine)
- **MCP** (Model Context Protocol) for AI client integration

## Engineering principles

- **Integer cents for money, always.** Floats lie about money. There is no float-based money anywhere in this codebase, not even in tests.
- **Soft delete only.** Deleted records are marked, not removed. Your history is preserved.
- **Drizzle migrations only.** No hand-rolled SQL alterations. The migration log is the source of truth for schema changes.
- **Test coverage targets:** 95%+ on financial calculations, 90%+ on shared utilities, 80%+ on services and routes. Lower than that isn't acceptable for code that touches your money.
- **AI rules are versioned.** System prompts that govern AI behavior live in source control and are reviewed like any other code.

## Status

Early development — rebuilding from scratch. See [WORKSTREAMS.md](./WORKSTREAMS.md) for what's being built and the current state of each workstream.

OpenPortfolio is not yet runnable. Setup instructions land in `docs/setup.md` once a thin end-to-end path is working.

## Contributing

OpenPortfolio is open source under the MIT license, but it's currently a personal project in active early-stage development. Issues and discussions are welcome; PRs are accepted but please open an issue first to discuss scope before submitting code.

The guardrails in this project — no buy/sell recommendations, real returns by default, bear cases required, no telemetry — are non-negotiable. Contributions that work against those principles, however well-engineered, will be declined.

## License

MIT.
