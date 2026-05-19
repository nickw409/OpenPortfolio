// Shared state machine for the server's lifecycle phase. The boot
// orchestration writes it; the boot-gate middleware and the health
// endpoint read it.
//
// Phases (see docs/specs/2026-05-18-backend-api-design.md §T4, §T6):
// - starting: backup + migrations running; only /api/v1/health responds
// - ready: serving normally
// - shutting_down: drain in progress; new requests get 503
// - degraded: boot failed or DB unreachable

export type ServerPhase = 'starting' | 'ready' | 'shutting_down' | 'degraded';

export interface ServerState {
  phase: ServerPhase;
  startedAt: number;
}

export function createServerState(): ServerState {
  return { phase: 'starting', startedAt: Date.now() };
}
