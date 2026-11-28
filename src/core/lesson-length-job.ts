/**
 * The length job (#132, ADR 0109): when a Course opens, each of its Lessons' length is read from
 * its file with ffmpeg, in the background, one Lesson at a time in Course order. A Lesson whose
 * file has not changed since it was probed keeps its cached length and is not probed again. What
 * the probes find is kept in the Lesson length cache, in batches, and is known at once to whoever
 * asks the job. Nothing here ever tells the learner: a failure is a log line, and the Lesson just
 * shows no length.
 */
import { lessonsInOrder, type Course, type Lesson } from './course-model.js';
import { ffmpegProgram, probeInTime, ProbeTimeout } from './ffmpeg-program.js';
import {
  cachedLessonLength,
  cachedLessonLengths,
  saveLessonLengths,
  type ProbedLength,
} from './lesson-length-cache.js';
import type { LessonLengths } from './lesson-tree.js';
import { messageOf } from './logger.js';
import type { FileStat, Ports } from './ports.js';

/** How many probed Lessons are kept in the cache at a time: global storage is not written per Lesson. */
const saveEvery = 20;

type LengthJobPorts = Pick<
  Ports,
  'fileSystem' | 'storage' | 'converter' | 'config' | 'ui' | 'logger' | 'clock' | 'bundledFfmpeg'
>;

/** The length job of the open Course. */
export interface LessonLengthJob {
  /**
   * The Lesson lengths known now, by Lesson id: the cached ones, as probes this window replace and
   * add to them. Read in the same turn; it never waits on a probe.
   */
  lengths(): LessonLengths;
  /** Stops the job: the Course was switched or closed. A probe under way is aborted. */
  stop(): void;
}

/**
 * Starts probing the Lesson lengths of `course`. `warnedPaths` is the window's set of ignored
 * `followalong.ffmpegPath` values, shared with the sound (ADR 0071). `landed` is called each time
 * {@link LessonLengthJob.lengths} changes, so what shows them can follow.
 */
export function startLessonLengthJob(
  course: Course,
  ports: LengthJobPorts,
  warnedPaths: Set<string>,
  landed: () => void = () => undefined,
): LessonLengthJob {
  const { fileSystem, logger, storage } = ports;
  const { folder } = course;
  const stopped = new AbortController();
  const { signal } = stopped;
  const known = new Map(cachedLessonLengths(storage.global, folder));
  /** What was probed and is not yet in the cache. */
  let unsaved = new Map<string, ProbedLength>();
  /** The ffmpeg to run, chosen at the first Lesson that needs a probe. */
  let program: Promise<string> | undefined;

  const warn = (message: string): void => {
    logger.log({ level: 'warn', message });
  };

  const save = async (): Promise<void> => {
    const batch = unsaved;
    unsaved = new Map();
    // Saved with no Lessons too: the Course is then the one opened most recently, and stays cached.
    await saveLessonLengths(ports, folder, batch);
  };

  /** The Lesson's stat, or `undefined` when it cannot be read (logged). */
  const statOf = async (lesson: Lesson): Promise<FileStat | undefined> => {
    try {
      const { size, modifiedMs } = await fileSystem.stat(lesson.path);
      return { size, modifiedMs };
    } catch (error) {
      warn(`Could not read the length of ${lesson.id}: ${messageOf(error)}`);
      return undefined;
    }
  };

  /** Probes one Lesson; `false` when the job must stop (stopped, no ffmpeg, a stalled drive). */
  const probe = async (lesson: Lesson, stat: FileStat): Promise<boolean> => {
    program ??= ffmpegProgram(ports, warnedPaths);
    let ffmpeg: string;
    try {
      ffmpeg = await program;
    } catch (error) {
      // The learner hears about a missing ffmpeg from the sound of an MP4 Lesson (ADR 0071).
      warn(`Not reading the Lesson lengths of ${folder}: ${messageOf(error)}`);
      return false;
    }
    let seconds: number | undefined;
    try {
      seconds = await probeInTime(
        ports.clock,
        lesson,
        { signal, stopped: 'The Course was closed.' },
        (probeSignal) =>
          ports.converter.lessonLength({
            program: ffmpeg,
            input: lesson.path,
            signal: probeSignal,
          }),
      );
    } catch (error) {
      if (signal.aborted) {
        return false;
      }
      warn(`Could not read the length of ${lesson.id}: ${messageOf(error)}`);
      // A drive that stalls on one Lesson stalls on the next: 30 s each would never end.
      return !(error instanceof ProbeTimeout);
    }
    if (signal.aborted) {
      return false;
    }
    unsaved.set(lesson.id, { ...stat, seconds });
    if (seconds !== undefined && seconds > 0) {
      known.set(lesson.id, seconds);
    } else {
      known.delete(lesson.id);
    }
    landed();
    return true;
  };

  const run = async (): Promise<void> => {
    for (const lesson of lessonsInOrder(course)) {
      const stat = await statOf(lesson);
      if (signal.aborted) {
        return;
      }
      if (
        stat === undefined ||
        cachedLessonLength(storage.global, folder, lesson.id, stat) !== undefined
      ) {
        continue;
      }
      if (!(await probe(lesson, stat))) {
        return;
      }
      if (unsaved.size >= saveEvery) {
        await save();
      }
    }
  };

  void run()
    .catch((error: unknown) => {
      warn(`The Lesson lengths of ${folder} stopped: ${messageOf(error)}`);
    })
    .then(save);

  return {
    lengths: () => new Map(known),
    stop() {
      stopped.abort();
    },
  };
}
