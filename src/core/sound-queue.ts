/**
 * The order in which Lessons get their sound (spec #12, Sound for MP4 Lessons; ticket #44). The
 * opened Lesson comes first, then the next {@link aheadCount} in Course order, one conversion at a
 * time, so moving on is instant and the machine stays responsive. Opening another Lesson puts it
 * first and stops the work no longer needed.
 *
 * The queue does not know what a conversion is: it runs `prepareNow`, which also finds a sound
 * prepared before and decides, from ffmpeg's probe, that a Lesson needs none. A sound that fails
 * ahead of time shows nothing to the learner, only a log line: the Lesson tries again when it is
 * opened.
 */
import type { Lesson } from './course-model.js';
import type { Logger } from './logger.js';

/** How many Lessons after the opened one get their sound ahead of time. */
const aheadCount = 3;

/**
 * What an MP4 Lesson's sound needs:
 * - `sidecar`: its sound as an MP3 at `path`;
 * - `none`: no sidecar, because the Lesson has no sound (`silent`), or its sound is one the page
 *   decodes itself (`ownSound`).
 */
export type PreparedSound =
  | { readonly kind: 'sidecar'; readonly path: string }
  | { readonly kind: 'none'; readonly why: 'silent' | 'ownSound' };

/** What preparing a Lesson's sound is told, and tells back. */
export interface SoundRequest {
  /** Aborting it stops the preparation, and rejects it. */
  readonly signal: AbortSignal;
  /**
   * How far a conversion is, in whole percent: 0 when it starts, then as ffmpeg reports. Never
   * called for a sound that was prepared before, or that needs no sidecar.
   */
  readonly onProgress: (percent: number) => void;
  /**
   * The sound codecs, by ffmpeg's names, the player page decodes in an MP4 besides AAC: what it
   * reported in `ready` (ADR 0056). A Lesson with such sound plays its own track: a sidecar would
   * play the sound twice (ADR 0034). Any other codec is converted, so a Lesson never stays silent
   * because of a guess here.
   */
  readonly pageDecodes: ReadonlySet<string>;
}

/** Prepares one Lesson's sound, now: what the queue orders. */
export type PrepareNow = (lesson: Lesson, request: SoundRequest) => Promise<PreparedSound>;

export interface SoundQueue {
  /**
   * Prepares the sound of the opened `lesson`, first in the queue: a conversion running ahead for
   * another Lesson is stopped, and one already running for this Lesson goes on, without starting
   * again. Rejects when the preparation fails or `request.signal` aborts.
   */
  prepare(lesson: Lesson, request: SoundRequest): Promise<PreparedSound>;
  /**
   * Tells the queue which Lesson is open: the next 3 after it in `lessonsInOrder` get their sound
   * once the opened Lesson's is done, one at a time. Work for Lessons no longer among them is
   * stopped, and the order follows the new Lesson. `undefined` when no Lesson needs sound ahead:
   * none is open, or the page plays AAC itself.
   */
  prepareAhead(
    opened: Lesson | undefined,
    lessonsInOrder: readonly Lesson[],
    pageDecodes: ReadonlySet<string>,
  ): void;
  /** Stops all work and rejects what waits for it: the Course is closed. */
  stop(): void;
}

const stoppedMessage = 'The sound was stopped.';

/** Why `signal` aborted, as an Error. */
function stopReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(stoppedMessage);
}

/** Someone waiting for a Lesson's sound: the opened Lesson. */
interface Waiter {
  readonly onProgress: (percent: number) => void;
}

/**
 * The preparation of one Lesson's sound:
 * - `queued`: waiting for its turn;
 * - `running`: under way;
 * - `preempted`: stopped to give the opened Lesson its turn, and back to `queued` once it ended;
 * - `dropped`: nothing needs it any more, and what it ends with is ignored.
 */
interface Job {
  readonly lesson: Lesson;
  readonly pageDecodes: ReadonlySet<string>;
  readonly waiters: Set<Waiter>;
  state: 'queued' | 'running' | 'preempted' | 'dropped';
  /** Stops the run under way. */
  stop: AbortController | undefined;
  /** How far the conversion is, once it reported. */
  percent: number | undefined;
  readonly outcome: Promise<PreparedSound>;
  readonly settle: {
    readonly resolve: (sound: PreparedSound) => void;
    readonly reject: (error: unknown) => void;
  };
}

function newJob(lesson: Lesson, pageDecodes: ReadonlySet<string>): Job {
  let settle: Job['settle'] | undefined;
  const outcome = new Promise<PreparedSound>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A job nobody waits for (one ahead of time) may fail without anyone to tell.
  outcome.catch(() => undefined);
  if (settle === undefined) {
    throw new Error('A promise runs its executor at once.');
  }
  return {
    lesson,
    pageDecodes,
    waiters: new Set(),
    state: 'queued',
    stop: undefined,
    percent: undefined,
    outcome,
    settle,
  };
}

export function createSoundQueue(prepareNow: PrepareNow, logger: Logger): SoundQueue {
  /** The jobs not ended, by Lesson id. */
  const jobs = new Map<string, Job>();
  /**
   * The Lessons whose sound was prepared since the learner opened the Lesson they are ahead of:
   * not looked at again until they move on, which finds a sound taken away since (cleared by hand,
   * or pruned) and a Lesson file that changed.
   */
  const prepared = new Set<string>();
  /** The Lesson `ahead` follows. */
  let openedId: string | undefined;
  /** The Lessons whose sound failed ahead of time: not tried again ahead of time. */
  const failed = new Set<string>();
  let ahead: readonly Lesson[] = [];
  let aheadDecodes: ReadonlySet<string> = new Set();
  let running: Job | undefined;
  let scheduled = false;
  let stopped = false;

  /** Drops a job nothing needs: its run is stopped and its end ignored. */
  function drop(job: Job, reason: string): void {
    job.state = 'dropped';
    jobs.delete(job.lesson.id);
    if (running === job) {
      running = undefined;
    }
    job.stop?.abort(new Error(reason));
  }

  function dropUnneeded(): void {
    for (const job of jobs.values()) {
      if (job.waiters.size === 0 && !ahead.some((lesson) => lesson.id === job.lesson.id)) {
        drop(job, 'The sound is no longer needed.');
      }
    }
  }

  /** The job that should run now: the opened Lesson's, else the one running, else the next ahead. */
  function pick(): Job | undefined {
    // A job stopped to make way waits for its old run to end (`ended`): it never runs twice at once.
    const opened = [...jobs.values()].find(
      (job) => job.waiters.size > 0 && job.state !== 'preempted',
    );
    if (opened !== undefined) {
      return opened;
    }
    if (running !== undefined) {
      return running;
    }
    for (const lesson of ahead) {
      if (lesson.container === 'mp4' && !prepared.has(lesson.id) && !failed.has(lesson.id)) {
        const job = jobs.get(lesson.id) ?? newJob(lesson, aheadDecodes);
        if (job.state === 'preempted') {
          continue;
        }
        jobs.set(lesson.id, job);
        return job;
      }
    }
    return undefined;
  }

  function advance(): void {
    if (stopped) {
      return;
    }
    const next = pick();
    if (next === undefined || next === running) {
      return;
    }
    if (running !== undefined) {
      // The opened Lesson is first: what runs ahead stops, and starts again in its turn.
      running.state = 'preempted';
      running.stop?.abort(new Error('The sound makes way for the opened Lesson.'));
    }
    run(next);
  }

  /** Starts the queue at the end of this turn, so what the caller does next is counted first. */
  function schedule(): void {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        advance();
      });
    }
  }

  function run(job: Job): void {
    const stop = new AbortController();
    job.stop = stop;
    job.state = 'running';
    running = job;
    prepareNow(job.lesson, {
      signal: stop.signal,
      pageDecodes: job.pageDecodes,
      onProgress: (percent) => {
        job.percent = percent;
        for (const waiter of job.waiters) {
          waiter.onProgress(percent);
        }
      },
    }).then(
      (sound) => {
        ended(job, { sound });
      },
      (error: unknown) => {
        ended(job, { error });
      },
    );
  }

  function ended(job: Job, result: { sound: PreparedSound } | { error: unknown }): void {
    if (job.state === 'dropped') {
      return;
    }
    if (running === job) {
      running = undefined;
    }
    if ('error' in result && job.state === 'preempted') {
      job.state = 'queued';
      job.stop = undefined;
      job.percent = undefined;
      schedule();
      return;
    }
    jobs.delete(job.lesson.id);
    if ('sound' in result) {
      prepared.add(job.lesson.id);
      job.settle.resolve(result.sound);
    } else {
      failed.add(job.lesson.id);
      if (job.waiters.size === 0) {
        const reason = result.error instanceof Error ? result.error.message : String(result.error);
        logger.log({
          level: 'warn',
          message: `Could not prepare the sound of ${job.lesson.id} ahead of time: ${reason} It is tried again when the Lesson is opened.`,
        });
      }
      job.settle.reject(result.error);
    }
    schedule();
  }

  return {
    prepare(lesson, request) {
      const { signal, onProgress } = request;
      if (stopped) {
        return Promise.reject(new Error(stoppedMessage));
      }
      if (signal.aborted) {
        return Promise.reject(stopReason(signal));
      }
      failed.delete(lesson.id);
      const job = jobs.get(lesson.id) ?? newJob(lesson, request.pageDecodes);
      jobs.set(lesson.id, job);
      const waiter: Waiter = { onProgress };
      job.waiters.add(waiter);
      if (job.percent !== undefined) {
        // Where the conversion already is: said once the caller has what it needs to hear it.
        queueMicrotask(() => {
          if (job.waiters.has(waiter) && job.percent !== undefined) {
            onProgress(job.percent);
          }
        });
      }
      schedule();
      return new Promise<PreparedSound>((resolve, reject) => {
        const leave = (): void => {
          job.waiters.delete(waiter);
          dropUnneeded();
          reject(stopReason(signal));
        };
        signal.addEventListener('abort', leave, { once: true });
        job.outcome.then(
          (sound) => {
            signal.removeEventListener('abort', leave);
            resolve(sound);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', leave);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    },

    prepareAhead(opened, lessonsInOrder, pageDecodes) {
      const here =
        opened === undefined ? -1 : lessonsInOrder.findIndex((lesson) => lesson.id === opened.id);
      if (opened?.id !== openedId) {
        openedId = opened?.id;
        prepared.clear();
      }
      ahead = here === -1 ? [] : lessonsInOrder.slice(here + 1, here + 1 + aheadCount);
      aheadDecodes = pageDecodes;
      dropUnneeded();
      schedule();
    },

    stop() {
      stopped = true;
      ahead = [];
      for (const job of [...jobs.values()]) {
        job.settle.reject(new Error(stoppedMessage));
        drop(job, stoppedMessage);
      }
    },
  };
}
