/**
 * The audio sidecar service (spec #12, Sound for MP4 Lessons; ADR 0034). VS Code cannot decode
 * AAC, the sound of every MP4 Lesson, so when the player says it cannot, the Lesson's sound is
 * converted to MP3 with ffmpeg and kept in Course data (`.followalong/sound`, or the fallback
 * storage of a read-only Course). The player plays it beside the video.
 *
 * Each MP3 is named by the Lesson's path relative to the Course, its size and its last change, so
 * it is reused on the next open and a Lesson file replaced on disk is converted again.
 */
import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';

import { openCourseData, type CourseData } from './course-data.js';
import { isFullPath } from './courses-roots.js';
import type { Lesson } from './course-model.js';
import { createSoundQueue } from './sound-queue.js';
import {
  FileSystemError,
  type ConversionRequest,
  type Disposable,
  type FileStat,
  type Ports,
} from './ports.js';

/** The Course data subfolder that holds prepared sound. */
const soundFolderName = 'sound';

/** The ffmpeg used on a machine with no bundled one, when `followalong.ffmpegPath` is not set. */
const pathProgram = 'ffmpeg';

/** `<Lesson file name>-<hash of relative path, size, last change>.mp3`: readable, and unique. */
function soundFileName(lesson: Lesson, { size, modifiedMs }: FileStat): string {
  const key = `${lesson.id}\n${String(size)}\n${String(Math.trunc(modifiedMs))}`;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const name = basename(lesson.id, extname(lesson.id))
    .replace(/[^\p{L}\p{N} ._-]/gu, '_')
    .slice(0, 60);
  return `${name}-${hash}.mp3`;
}

/**
 * The ffmpeg to run (ADR 0071): the `followalong.ffmpegPath` setting when it names a full path,
 * else the ffmpeg the extension ships, where there is one for this machine, else the one on PATH.
 * Rejects when the shipped ffmpeg is wanted but its file is gone: the sound then fails like any
 * other, and the learner can play without it.
 */
async function ffmpegProgram(ports: SidecarSoundPorts, warned: Set<string>): Promise<string> {
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
  if (!(await exists(fileSystem, bundledFfmpeg))) {
    throw new Error(
      `The ffmpeg that comes with FollowAlong is missing (${bundledFfmpeg}). Reinstall FollowAlong, or set followalong.ffmpegPath to an ffmpeg you installed.`,
    );
  }
  return bundledFfmpeg;
}

/** Whether a file is at `path`. */
async function exists(fileSystem: Ports['fileSystem'], path: string): Promise<boolean> {
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

type SidecarSoundPorts = Pick<
  Ports,
  'fileSystem' | 'storage' | 'converter' | 'config' | 'ui' | 'logger' | 'clock' | 'bundledFfmpeg'
>;

/**
 * How long ffmpeg may take to read a Lesson's sound track before the sound is given up. A local
 * file takes a fraction of a second; a stalled network mount or a disconnected drive never answers,
 * and the Lesson's controls would stay hidden for ever (ADR 0056).
 */
const probeTimeoutMs = 30_000;

/**
 * How long a conversion may go without reporting progress before the sound is given up. ffmpeg
 * reports every fraction of a second while it works; a drive that drops mid-conversion leaves it
 * blocked reading, and the learner would see "Preparing sound… 37%" for ever (ADR 0056).
 */
const stallTimeoutMs = 60_000;

/**
 * Writes `output` with the converter. Rejects when the conversion reports no progress for
 * {@link stallTimeoutMs}, even if ffmpeg ignores being stopped, so nothing waits on it; every
 * progress it reports, the same percent again included, starts the time over.
 */
async function extractWithStallGuard(
  { clock, converter }: SidecarSoundPorts,
  lesson: Lesson,
  request: ConversionRequest,
): Promise<void> {
  const { signal, onProgress } = request;
  const stalled = new AbortController();
  let timer: Disposable | undefined;
  let leave: (() => void) | undefined;
  let restart: () => void = () => undefined;
  const stall = new Promise<never>((_resolve, reject) => {
    restart = () => {
      timer?.dispose();
      timer = clock.schedule(stallTimeoutMs, () => {
        stalled.abort();
        reject(
          new Error(
            `ffmpeg made no progress on “${basename(lesson.id)}” for ${String(stallTimeoutMs / 1000)} seconds. Is its drive or network folder still there?`,
          ),
        );
      });
    };
    // The learner left the Lesson: nothing waits for an ffmpeg that does not stop.
    leave = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('The sound was stopped.'));
    };
    signal.addEventListener('abort', leave, { once: true });
    restart();
  });
  const extraction = converter.extractSound({
    ...request,
    signal: AbortSignal.any([signal, stalled.signal]),
    onProgress: (percent) => {
      restart();
      onProgress(percent);
    },
  });
  // Whichever loses the race must not become an unhandled rejection.
  extraction.catch(() => undefined);
  stall.catch(() => undefined);
  try {
    await Promise.race([extraction, stall]);
  } finally {
    timer?.dispose();
    if (leave !== undefined) {
      signal.removeEventListener('abort', leave);
    }
  }
}

/**
 * The codec of `lesson`'s first sound track, or `undefined` for a silent video. Rejects when
 * ffmpeg does not answer in time, even if it ignores being stopped, so nothing waits on it.
 */
async function probeSound(
  { clock, converter }: SidecarSoundPorts,
  lesson: Lesson,
  program: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const stalled = new AbortController();
  let timer: Disposable | undefined;
  let leave: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    // The learner left the Lesson: nothing waits for an ffmpeg that does not stop.
    leave = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('The sound was stopped.'));
    };
    signal.addEventListener('abort', leave, { once: true });
    timer = clock.schedule(probeTimeoutMs, () => {
      stalled.abort();
      reject(
        new Error(
          `ffmpeg did not finish reading “${basename(lesson.id)}” within ${String(probeTimeoutMs / 1000)} seconds. Is its drive or network folder still there?`,
        ),
      );
    });
  });
  const probe = converter.soundCodec({
    program,
    input: lesson.path,
    signal: AbortSignal.any([signal, stalled.signal]),
  });
  // Whichever loses the race must not become an unhandled rejection.
  probe.catch(() => undefined);
  timeout.catch(() => undefined);
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    timer?.dispose();
    if (leave !== undefined) {
      signal.removeEventListener('abort', leave);
    }
  }
}

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

/** The audio sidecars of one Course, kept in its Course data. */
export interface SidecarSound {
  /**
   * Resolves with what the opened `lesson`'s sound needs: the MP3 prepared before, if any, else a
   * new conversion, unless it needs none. It goes first in the queue (see {@link prepareAhead}).
   * Rejects when the conversion fails or the request is aborted.
   */
  prepare(lesson: Lesson, request: SoundRequest): Promise<PreparedSound>;
  /**
   * Prepares the sound of the 3 Lessons after `opened` in `lessonsInOrder`, once the opened
   * Lesson's is done, one at a time and at low process priority. A Lesson with its sound prepared
   * before, or that needs none, is passed over. Work for Lessons no longer among the next 3 is
   * stopped; `undefined` stops all of it. A sound that fails here shows nothing: the Lesson tries
   * again when it is opened.
   */
  prepareAhead(
    opened: Lesson | undefined,
    lessonsInOrder: readonly Lesson[],
    pageDecodes: ReadonlySet<string>,
  ): void;
  /** Stops all preparation: the Course is closed. */
  stop(): void;
}

/**
 * `folder` is the Course folder's absolute path, which also keys the fallback storage.
 * `warnedPaths` holds the `followalong.ffmpegPath` values the learner was told are ignored, shared
 * across the Courses of one window so each is said once.
 */
export function openSidecarSound(
  folder: string,
  ports: SidecarSoundPorts,
  warnedPaths: Set<string>,
): SidecarSound {
  const data = openCourseData(folder, ports);
  return createSoundQueue(
    (lesson, request) => prepareSound(ports, data, lesson, request, warnedPaths),
    ports.logger,
  );
}

async function prepareSound(
  ports: SidecarSoundPorts,
  data: CourseData,
  lesson: Lesson,
  { signal, onProgress, pageDecodes }: SoundRequest,
  warnedPaths: Set<string>,
): Promise<PreparedSound> {
  const { fileSystem, logger } = ports;
  const name = soundFileName(lesson, await fileSystem.stat(lesson.path));
  for (const folder of data.folders(soundFolderName)) {
    const path = join(folder, name);
    if (await exists(fileSystem, path)) {
      logger.log({ level: 'debug', message: `Reusing the prepared sound of ${lesson.id}` });
      return { kind: 'sidecar', path };
    }
  }
  signal.throwIfAborted();
  const program = await ffmpegProgram(ports, warnedPaths);
  const codec = await probeSound(ports, lesson, program, signal);
  if (codec === undefined || pageDecodes.has(codec)) {
    const why = codec === undefined ? 'silent' : 'ownSound';
    logger.log({
      level: 'info',
      message: `${lesson.id} needs no sidecar: ${codec === undefined ? 'it has no sound' : `the page decodes its ${codec} sound`}.`,
    });
    return { kind: 'none', why };
  }
  logger.log({ level: 'info', message: `Preparing the sound of ${lesson.id} with ${program}` });
  const convertInto = async (folder: string): Promise<string> => {
    const output = join(folder, name);
    await extractWithStallGuard(ports, lesson, {
      program,
      input: lesson.path,
      output,
      // Whoever waits for the sound, the machine and the editor come first.
      lowPriority: true,
      onProgress,
      signal,
    });
    return output;
  };
  // The learner is told from here: a sound needing no conversion never shows "Preparing sound…".
  onProgress(0);
  const folder = await data.prepareFolder(soundFolderName);
  let output: string;
  try {
    output = await convertInto(folder);
  } catch (error) {
    // A sound folder that was there already, in a Course that has turned read-only: the sound goes
    // to the fallback storage, as Course data does (story 107), with only a log line.
    const fallback = FileSystemError.is(error, 'readOnly')
      ? await data.prepareFallbackFolder(soundFolderName)
      : folder;
    if (fallback === folder) {
      throw error;
    }
    output = await convertInto(fallback);
  }
  logger.log({ level: 'info', message: `Prepared the sound of ${lesson.id}` });
  return { kind: 'sidecar', path: output };
}
