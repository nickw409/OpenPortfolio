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

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (res.ok) {
    return (await res.json()) as T;
  }
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
  throw new ApiError(envelope, res.status);
}
