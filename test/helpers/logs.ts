import { afterAll, expect } from 'vitest';
import { createLogger, type Logger } from '../../src/logger.js';
import { SENSITIVE } from './constants.js';

export type LogCapture = { logger: Logger; lines: string[]; records(): Record<string, unknown>[] };

export function captureLogs(): LogCapture {
  const lines: string[] = [];
  return {
    logger: createLogger((l) => lines.push(l)),
    lines,
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

export function expectCleanLogs(lines: readonly string[], extra: readonly string[] = []): void {
  for (const line of lines) {
    expect(() => JSON.parse(line)).not.toThrow();
    for (const needle of [...SENSITIVE, ...extra]) {
      expect(line.includes(needle), `log line contains sensitive value ${JSON.stringify(needle.slice(0, 6))}...`).toBe(false);
    }
  }
}

/** Registers a suite-wide check: whatever the suite logged contains nothing sensitive. */
export function assertCleanLogsAfterAll(capture: LogCapture): void {
  afterAll(() => {
    expect(capture.lines.length, 'the suite should have produced log lines to check').toBeGreaterThan(0);
    expectCleanLogs(capture.lines);
  });
}
