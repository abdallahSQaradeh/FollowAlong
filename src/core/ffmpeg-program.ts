/**
 * Which ffmpeg FollowAlong runs (ADR 0071), for the sound of MP4 Lessons and for Lesson lengths
 * alike: one rule, and one set of warnings per window.
 */
import { basename } from 'node:path';

import type { Lesson } from './course-model.js';
import { isFullPath } from './folder-identity.js';
import { FileSystemError, type Clock, type Disposable, type Ports } from './ports.js';

/** The ffmpeg used on a machine with no bundled one, when `followalong.ffmpegPath` is not set. */
const pathProgram = 'ffmpeg';

/** What choosing the ffmpeg reads, and where it says a setting is ignored. */
export type FfmpegProgramPorts = Pick<
  Ports,
  'fileSystem' | 'config' | 'ui' | 'logger' | 'bundledFfmpeg'
>;

/**
 * The ffmpeg to run (ADR 0071): the `followalong.ffmpegPath` setting when it names a full path,
 * else the ffmpeg the extension ships, where there is one for this machine, else the one on PATH.
 * Rejects when the shipped ffmpeg is wanted but its file is gone. `warned` holds the setting values
 * the learner was told are ignored, shared by the whole window so each is said once.
 */
export async function ffmpegProgram(
  ports: FfmpegProgramPorts,
  warned: Set<string>,
): Promise<string> {
  const { config, ui, logger, fileSystem, bundledFfmpeg } = ports;
  const setting = config.get('ffmpegPath');
  const value = typeof setting === 'string' ? setting.trim() : '';
  if (value !== '') {
    if (isFullPath(value)) {
      return value;
    }
    // A relative path would resolve against whatever folder VS Code runs in (as for Courses
    // roots). Said once per window and value, not at every Lesson.
    if (!warned.has(value)) {
      warned.add(value);
      const instead =
        bundledFfmpeg === undefined ? 'ffmpeg on PATH' : 'the ffmpeg that comes with FollowAlong';
      logger.log({
        level: 'warn',
        message: `Ignoring followalong.ffmpegPath ${value}: not a full path.`,
      });
      ui.showMessage({
        severity: 'warning',
        text: `FollowAlong ignores the followalong.ffmpegPath setting “${value}”: it must be a full path, such as C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe. It uses ${instead} instead.`,
      });
    }
  }
  if (bundledFfmpeg === undefined) {
    return pathProgram;
  }
  if (!(await fileExists(fileSystem, bundledFfmpeg))) {
    throw new Error(
      `The ffmpeg that comes with FollowAlong is missing (${bundledFfmpeg}). Reinstall FollowAlong, or set followalong.ffmpegPath to an ffmpeg you installed.`,
    );
  }
  return bundledFfmpeg;
}

/**
 * How long ffmpeg may take to read a Lesson before the read is given up. A local file takes a
 * fraction of a second; a stalled network mount or a disconnected drive never answers, and the
 * Lesson's controls would stay hidden for ever (ADR 0056).
 */
export const probeTimeoutMs = 30_000;

/** ffmpeg did not finish reading a Lesson within {@link probeTimeoutMs}. */
export class ProbeTimeout extends Error {}

/**
 * Runs `probe`, which reads `lesson` with ffmpeg. Rejects with a {@link ProbeTimeout} when it does
 * not answer within {@link probeTimeoutMs} on the clock, and with `signal`'s reason (else
 * `stopped`) as soon as `signal` aborts, even if ffmpeg ignores being stopped, so nothing waits on
 * it. The signal given to `probe` aborts in both cases.
 */
export async function probeInTime<T>(
  clock: Clock,
  lesson: Lesson,
  { signal, stopped }: { readonly signal: AbortSignal; readonly stopped: string },
  probe: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timedOut = new AbortController();
  let timer: Disposable | undefined;
  let leave: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    // Whoever asked has moved on: nothing waits for an ffmpeg that does not stop.
    leave = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(stopped));
    };
    signal.addEventListener('abort', leave, { once: true });
    timer = clock.schedule(probeTimeoutMs, () => {
      timedOut.abort();
      reject(
        new ProbeTimeout(
          `ffmpeg did not finish reading “${basename(lesson.id)}” within ${String(probeTimeoutMs / 1000)} seconds. Is its drive or network folder still there?`,
        ),
      );
    });
  });
  const probing = probe(AbortSignal.any([signal, timedOut.signal]));
  // Whichever loses the race must not become an unhandled rejection.
  probing.catch(() => undefined);
  timeout.catch(() => undefined);
  try {
    return await Promise.race([probing, timeout]);
  } finally {
    timer?.dispose();
    if (leave !== undefined) {
      signal.removeEventListener('abort', leave);
    }
  }
}

/** Whether a file is at `path`. */
export async function fileExists(fileSystem: Ports['fileSystem'], path: string): Promise<boolean> {
  try {
    await fileSystem.stat(path);
    return true;
  } catch (error) {
    if (FileSystemError.is(error, 'notFound')) {
      return false;
    }
    throw error;
  }
}
