/**
 * The audio sidecar service (spec #12, Sound for MP4 Lessons; ADR 0034). VS Code cannot decode
 * AAC, the sound of every MP4 Lesson, so when the player says it cannot, the Lesson's sound is
 * converted to MP3 with ffmpeg and kept in Course data (`.followalong/sound`, or the fallback
 * storage of a read-only Course). The player plays it beside the muted video.
 *
 * Each MP3 is named by the Lesson's path relative to the Course, its size and its last change, so
 * it is reused on the next open and a Lesson file replaced on disk is converted again.
 */
import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';

import type { CourseData } from './course-data.js';
import type { Lesson } from './course-model.js';
import { FileSystemError, type Ports } from './ports.js';

/** The Course data subfolder that holds prepared sound. */
export const soundFolderName = 'sound';

/** The ffmpeg used when `followalong.ffmpegPath` is not set: the one on PATH. */
const defaultProgram = 'ffmpeg';

/** `<Lesson file name>-<hash of relative path, size, last change>.mp3`: readable, and unique. */
function soundFileName(lesson: Lesson, size: number, modifiedMs: number): string {
  const key = `${lesson.id}\n${String(size)}\n${String(Math.trunc(modifiedMs))}`;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const name = basename(lesson.id, extname(lesson.id))
    .replace(/[^\p{L}\p{N} ._-]/gu, '_')
    .slice(0, 60);
  return `${name}-${hash}.mp3`;
}

/** The ffmpeg to run: the `followalong.ffmpegPath` setting when it names one, else the default. */
function ffmpegProgram(config: Ports['config']): string {
  const setting = config.get('ffmpegPath');
  return typeof setting === 'string' && setting.trim() !== '' ? setting.trim() : defaultProgram;
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

/**
 * Resolves with the path of `lesson`'s sound as an MP3: the one prepared before, if any, else a
 * new conversion. Rejects when the conversion fails or `signal` aborts it.
 */
export async function prepareSound(
  ports: Pick<Ports, 'fileSystem' | 'converter' | 'config' | 'logger'>,
  data: CourseData,
  lesson: Lesson,
  signal: AbortSignal,
): Promise<string> {
  const { fileSystem, converter, config, logger } = ports;
  const { size, modifiedMs } = await fileSystem.stat(lesson.path);
  const name = soundFileName(lesson, size, modifiedMs);
  for (const folder of data.folders(soundFolderName)) {
    const path = join(folder, name);
    if (await exists(fileSystem, path)) {
      logger.log({ level: 'debug', message: `Reusing the prepared sound of ${lesson.id}` });
      return path;
    }
  }
  signal.throwIfAborted();
  const output = join(await data.prepareFolder(soundFolderName), name);
  const program = ffmpegProgram(config);
  logger.log({ level: 'info', message: `Preparing the sound of ${lesson.id} with ${program}` });
  await converter.extractSound({
    program,
    input: lesson.path,
    output,
    // The "Preparing sound… N%" overlay is ticket #42's.
    onProgress: () => undefined,
    signal,
  });
  logger.log({ level: 'info', message: `Prepared the sound of ${lesson.id}` });
  return output;
}
