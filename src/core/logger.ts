/**
 * The logger port. The core logs only through this port, never through `console`:
 * the VS Code adapter writes to an output channel, and tests pass a recording fake.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
}

export interface Logger {
  log(entry: LogEntry): void;
}

const severity: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Wraps a logger so entries below `minimum` are dropped (the level a learner picks in settings). */
export function atLeast(minimum: LogLevel, sink: Logger): Logger {
  return {
    log(entry) {
      if (severity[entry.level] >= severity[minimum]) {
        sink.log(entry);
      }
    },
  };
}

/**
 * The text of something thrown, for a log line or a message: an `Error`'s message, or anything
 * else as `String` spells it.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
