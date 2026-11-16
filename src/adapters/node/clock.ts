/** The Clock port over Node's timers. */
import type { Clock } from '../../core/ports.js';

export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    schedule(delayMs, callback) {
      const timer = setTimeout(callback, delayMs);
      return {
        dispose: () => {
          clearTimeout(timer);
        },
      };
    },
  };
}
