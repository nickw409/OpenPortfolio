import type { LayoutItem } from './types';

const API_PREFIX = '/api/v1/dashboard';

export interface ErrorEnvelope {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: string;
  readonly status: number;
  readonly context?: Record<string, unknown>;

  constructor(envelope: ErrorEnvelope, status: number) {
    super(envelope.message);
    this.code = envelope.code;
    this.status = status;
    this.context = envelope.context;
  }
}

async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw await extractError(res);
  return (await res.json()) as T;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await extractError(res);
  return (await res.json()) as T;
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await extractError(res);
  return (await res.json()) as T;
}

async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${API_PREFIX}${path}`, { method: 'DELETE' });
  if (!res.ok) throw await extractError(res);
}

async function extractError(res: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope;
  try {
    const body = (await res.json()) as Partial<ErrorEnvelope>;
    envelope = {
      code: body.code ?? 'network.unexpected_response',
      message: body.message ?? `Request failed with status ${res.status}`,
      context: body.context,
    };
  } catch {
    envelope = {
      code: 'network.unexpected_response',
      message: `Request failed with status ${res.status}`,
    };
  }
  return new ApiError(envelope, res.status);
}

export function fetchDefaultLayout(signal?: AbortSignal): Promise<{ layout: LayoutItem }> {
  return apiGet('/layouts', signal);
}

export function createLayout(name: string, isDefault = false): Promise<{ layout: LayoutItem }> {
  return apiPost('/layouts', { name, is_default: isDefault });
}

export function resetLayout(id: number): Promise<{ layout: LayoutItem }> {
  return apiPost(`/layouts/${id}/reset`, {});
}

export function addTile(
  layoutId: number,
  tileType: string,
  positionJson: string,
  configJson: string,
): Promise<{ tile: { id: number } }> {
  return apiPost(`/layouts/${layoutId}/tiles`, {
    tile_type: tileType,
    position_json: positionJson,
    config_json: configJson,
  });
}

export function updateTile(
  layoutId: number,
  tileId: number,
  patch: { position_json?: string; config_json?: string },
): Promise<{ tile: { id: number } }> {
  return apiPatch(`/layouts/${layoutId}/tiles/${tileId}`, patch);
}

export function deleteTile(layoutId: number, tileId: number): Promise<void> {
  return apiDelete(`/layouts/${layoutId}/tiles/${tileId}`);
}
