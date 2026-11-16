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
import { FileSystemError, type FileStat, type Ports } from './ports.js';

/** The Course data subfolder that holds prepared sound. */
const soundFolderName = 'sound';

/**
 * The sound codecs the player page decodes in an MP4 itself: Chromium's own codecs, which VS Code
 * ships (it leaves out AAC). A Lesson with such sound plays its own track: a sidecar would play the
 * sound twice (ADR 0034).
 */
const pageDecodable = new Set(['mp3', 'opus', 'vorbis', 'flac']);

/** The ffmpeg used when `followalong.ffmpegPath` is not set: the one on PATH. */
const defaultProgram = 'ffmpeg';

/** `<Lesson file name>-<hash of relative path, size, last change>.mp3`: readable, and unique. */
function soundFileName(lesson: Lesson, { size, modifiedMs }: FileStat): string {
  const key = `${lesson.id}\n${String(size)}\n${String(Math.trunc(modifiedMs))}`;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const name = basename(lesson.id, extname(lesson.id))
    .replace(/[^\p{L}\p{N} ._-]/gu, '_')
    .slice(0, 60);
  return `${name}-${hash}.mp3`;
}

/** The ffmpeg to run: the `followalong.ffmpegPath` setting when it names one, else the default. */
function ffmpegProgram(ports: SidecarSoundPorts, warned: Set<string>): string {
  const { config, ui, logger } = ports;
  const setting = config.get('ffmpegPath');
  const value = typeof setting === 'string' ? setting.trim() : '';
  if (value === '') {
    return defaultProgram;
  }
  if (isFullPath(value)) {
    return value;
  }
  // A relative path would resolve against whatever folder VS Code runs in (as for Courses roots).
  // Said once per window and value, not at every Lesson.
  if (!warned.has(value)) {
    warned.add(value);
    logger.log({
      level: 'warn',
      message: `Ignoring followalong.ffmpegPath ${value}: not a full path.`,
    });
    ui.showMessage({
      severity: 'warning',
      text: `FollowAlong ignores the followalong.ffmpegPath setting “${value}”: it must be a full path, such as C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe. It uses ffmpeg on PATH instead.`,
    });
  }
  return defaultProgram;
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
  'fileSystem' | 'storage' | 'converter' | 'config' | 'ui' | 'logger'
>;

/**
 * What an MP4 Lesson's sound needs:
 * - `sidecar`: its sound as an MP3 at `path`;
 * - `none`: no sidecar, because the Lesson has no sound (`silent`), or its sound is one the page
 *   decodes itself (`ownSound`).
 */
export type PreparedSound =
  | { readonly kind: 'sidecar'; readonly path: string }
  | { readonly kind: 'none'; readonly why: 'silent' | 'ownSound' };

/** The audio sidecars of one Course, kept in its Course data. */
export interface SidecarSound {
  /**
   * Resolves with what `lesson`'s sound needs: the MP3 prepared before, if any, else a new
   * conversion, unless it needs none. Rejects when the conversion fails or `signal` aborts it.
   */
  prepare(lesson: Lesson, signal: AbortSignal): Promise<PreparedSound>;
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
  return {
    prepare: (lesson, signal) => prepareSound(ports, data, lesson, signal, warnedPaths),
  };
}

async function prepareSound(
  ports: SidecarSoundPorts,
  data: CourseData,
  lesson: Lesson,
  signal: AbortSignal,
  warnedPaths: Set<string>,
): Promise<PreparedSound> {
  const { fileSystem, converter, logger } = ports;
  const name = soundFileName(lesson, await fileSystem.stat(lesson.path));
  for (const folder of data.folders(soundFolderName)) {
    const path = join(folder, name);
    if (await exists(fileSystem, path)) {
      logger.log({ level: 'debug', message: `Reusing the prepared sound of ${lesson.id}` });
      return { kind: 'sidecar', path };
    }
  }
  signal.throwIfAborted();
  const program = ffmpegProgram(ports, warnedPaths);
  const codec = await converter.soundCodec({ program, input: lesson.path, signal });
  if (codec === undefined || pageDecodable.has(codec)) {
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
    await converter.extractSound({
      program,
      input: lesson.path,
      output,
      // The "Preparing sound… N%" overlay is ticket #42's.
      onProgress: () => undefined,
      signal,
    });
    return output;
  };
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
