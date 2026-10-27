import type { ILogger, LogLevel } from '@microsoft/teams.common';

/**
 * Structured JSON logs with an allowlist of fields. Anything not on the list is
 * dropped, and string values must look like an identifier or status word, so an
 * email, user id (`a|b|c`), URL or card text cannot be logged even by mistake.
 */
const ALLOWED_FIELDS = new Set([
  'delivery_id',
  'status',
  'code',
  'reason',
  'outcome',
  'http_status',
  'phase',
  'route',
  'duration_ms',
  'count',
  'port',
]);

const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

export type LogFields = Record<string, string | number | boolean | undefined>;
export type LogLevelName = 'info' | 'warn' | 'error' | 'critical';

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  critical(event: string, fields?: LogFields): void;
}

export type LogSink = (line: string) => void;

export const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(sink: LogSink = stdoutSink): Logger {
  const emit = (level: LogLevelName, event: string, fields?: LogFields) => {
    const out: Record<string, string | number | boolean> = {
      ts: new Date().toISOString(),
      level,
      event: SAFE_STRING.test(event) ? event : 'invalid_event_name',
    };
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (!ALLOWED_FIELDS.has(k) || v === undefined) continue;
      if (typeof v === 'string') {
        out[k] = SAFE_STRING.test(v) ? v : 'redacted';
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        out[k] = v;
      } else if (typeof v === 'boolean') {
        out[k] = v;
      }
    }
    sink(JSON.stringify(out));
  };
  return {
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
    critical: (e, f) => emit('critical', e, f),
  };
}

/**
 * Adapter for the Teams SDK's own logger slot. The SDK logs activity bodies at
 * debug, URLs inside JWT errors, and axios errors carry request headers, so this
 * keeps only the level: no message, no arguments.
 */
export function createSdkLogger(logger: Logger): ILogger {
  const sdk: ILogger = {
    debug: () => {},
    trace: () => {},
    info: () => {},
    warn: () => logger.warn('sdk_log'),
    error: () => logger.error('sdk_log'),
    log: (level: LogLevel) => {
      if (level === 'warn') logger.warn('sdk_log');
      else if (level === 'error') logger.error('sdk_log');
    },
    child: () => sdk,
  };
  return sdk;
}
