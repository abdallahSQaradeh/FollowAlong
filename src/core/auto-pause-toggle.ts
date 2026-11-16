/**
 * Toggle Auto-pause (spec #12, story 105; ADR 0098): switches `followalong.autoPause` between
 * `off` and the last mode that was on. It writes only that setting; the quiet period is
 * `followalong.autoPauseResumeAfter` (ADR 0089), and the Loaded Lesson reacts to the change of the
 * mode as it does to the learner's own edit of the setting.
 */
import { readAutoPauseMode, type AutoPauseOnMode } from './auto-pause.js';
import type { Config, Storage } from './ports.js';

/** The mode switched on when none was ever on. */
const defaultMode: AutoPauseOnMode = 'pause';

/** Where the last mode that was on is kept, in the global storage, so it outlives a restart. */
const lastModeKey = 'lastAutoPauseMode';

function lastMode(storage: Pick<Storage, 'global'>): AutoPauseOnMode {
  const value = storage.global.get(lastModeKey);
  return value === 'pause' || value === 'pauseAndResume' ? value : defaultMode;
}

/** Switches auto-pause off, or back to the last mode that was on (`pause` if none). */
export async function toggleAutoPause(
  config: Pick<Config, 'get' | 'update'>,
  storage: Pick<Storage, 'global'>,
): Promise<void> {
  const mode = readAutoPauseMode(config);
  if (mode === 'off') {
    await config.update('autoPause', lastMode(storage));
    return;
  }
  await storage.global.set(lastModeKey, mode);
  await config.update('autoPause', 'off');
}
