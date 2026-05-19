import pino, { type Logger, type LoggerOptions } from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

// Paths grow as secrets are introduced (price-provider API keys in
// workstream 6, loopback tokens if added in workstream 11). Empty for
// now — no secrets exist in the v1.0 skeleton.
const REDACT_PATHS: string[] = [];

export interface CreateLoggerOptions {
  level?: string;
  pretty?: boolean;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.OPENPORTFOLIO_LOG_LEVEL ?? 'info';
  const pretty = opts.pretty ?? !isProduction;

  const base: LoggerOptions = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };

  if (pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
      },
    });
  }

  return pino(base);
}

export const logger: Logger = createLogger();
