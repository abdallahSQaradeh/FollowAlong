import { describe, expect, it } from 'vitest';

import { atLeast, type LogEntry } from '../../src/core/logger.js';

describe('logger port', () => {
  it('passes entries at or above the minimum level and drops the rest', () => {
    const written: LogEntry[] = [];
    const logger = atLeast('info', { log: (entry) => written.push(entry) });

    logger.log({ level: 'debug', message: 'scan step' });
    logger.log({ level: 'info', message: 'Course opened' });
    logger.log({ level: 'error', message: 'sound failed' });

    expect(written.map((entry) => entry.message)).toEqual(['Course opened', 'sound failed']);
  });
});
