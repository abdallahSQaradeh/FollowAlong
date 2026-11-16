/**
 * The Converter port over ffmpeg (the audio sidecar, ADR 0034). It runs the program the core
 * chose (`followalong.ffmpegPath`, or ffmpeg on PATH until the bundled one lands), always with an
 * argument array and never through a shell. It reads which sound a Lesson has, and converts the
 * first sound track to MP3. ffmpeg writes a temp file beside the output, renamed over it once
 * whole, so a conversion cut short never looks like a finished one.
 */
import { spawn } from 'node:child_process';
import { open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  FileSystemError,
  type ConversionRequest,
  type Converter,
  type SoundProbe,
} from '../../core/ports.js';

/** The last lines of ffmpeg's error output kept for the reason of a failure. */
const reasonLines = 3;
/** The longest unfinished line kept from ffmpeg's output; ffmpeg's own lines are far shorter. */
const longestLine = 64 * 1024;
/**
 * A temp file untouched this long is left from a conversion that died with its window: ffmpeg
 * writes to a running one many times a second.
 */
const stalePartMs = 10 * 60 * 1000;

/** `HH:MM:SS.xx` in ffmpeg's output, in seconds. */
function seconds(hours: string, minutes: string, rest: string): number {
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(rest);
}

/** The ffmpeg arguments that write `input`'s first sound track to `output` as MP3. */
function soundArguments(input: string, output: string): string[] {
  return [
    ['-hide_banner', '-nostdin', '-y', '-i', input],
    // Sound only: the first audio track, VBR MP3 at about 165 kb/s (`-q:a 4`), metadata dropped.
    ['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '4', '-map_metadata', '-1'],
    ['-f', 'mp3', output],
  ].flat();
}

/** What a run of ffmpeg ended with: its exit code, and the last lines it wrote. */
interface Run {
  readonly code: number | null;
  readonly tail: readonly string[];
}

/**
 * Runs ffmpeg and hands each line of its error output (where it reports) to `onLine`. Resolves
 * once ffmpeg has exited, whatever its code: on Windows a file a running ffmpeg still holds cannot
 * be removed, so a cancel or a failure must wait for it before cleaning up. Rejects when ffmpeg
 * cannot be started, or `signal` stopped it.
 */
function runFfmpeg(
  program: string,
  args: readonly string[],
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      signal,
    });
    let tail: string[] = [];
    let pending = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // ffmpeg ends its progress lines with \r, other lines with \n.
      const lines = (pending + chunk).split(/\r\n|\r|\n/);
      pending = (lines.pop() ?? '').slice(-longestLine);
      for (const line of lines) {
        onLine(line);
        if (line.trim() !== '') {
          tail = [...tail, line.trim()].slice(-reasonLines);
        }
      }
    });
    let failure: Error | undefined;
    child.on('error', (error) => {
      const code = 'code' in error ? error.code : undefined;
      failure ??=
        code === 'ENOENT'
          ? new Error(
              `ffmpeg was not found (${program}). Install ffmpeg, or set followalong.ffmpegPath to it.`,
            )
          : error;
    });
    child.on('close', (code) => {
      if (failure === undefined) {
        resolve({ code, tail });
      } else {
        reject(failure);
      }
    });
  });
}

/** The reason ffmpeg gave, without the name of a temp file the learner never sees. */
function reason(run: Run, temporary: string, shownAs: string): string {
  return `ffmpeg exited with code ${String(run.code)}: ${run.tail.join(' ').replaceAll(temporary, shownAs)}`;
}

/** Removes temp files that conversions which died with their window left in `folder`. */
async function sweepStaleParts(folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => []);
  const now = Date.now();
  for (const name of names.filter((entry) => entry.startsWith('.') && entry.endsWith('.part'))) {
    const path = join(folder, name);
    const changed = await stat(path).then(
      (found) => found.mtimeMs,
      () => now,
    );
    if (now - changed > stalePartMs) {
      // Best effort: a file another window still holds stays until a later conversion.
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Creates the temp file, so a folder that cannot be written fails here, with the read-only check
 * the core falls back on, rather than as an ffmpeg error. ffmpeg then writes over it (`-y`).
 */
async function createTemporary(temporary: string): Promise<void> {
  try {
    await (await open(temporary, 'w')).close();
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new FileSystemError(
        'readOnly',
        dirname(temporary),
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

/** Numbers the temp files, so a new conversion never writes where a cancelled one may still be. */
let conversions = 0;

async function convert(request: ConversionRequest, temporary: string): Promise<void> {
  const { program, input, output, onProgress, signal } = request;
  let duration = 0;
  const run = await runFfmpeg(program, soundArguments(input, temporary), signal, (line) => {
    const durationMatch = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
    if (durationMatch !== null && duration === 0) {
      const [, hours = '0', minutes = '0', rest = '0'] = durationMatch;
      duration = seconds(hours, minutes, rest);
    }
    const timeMatch = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
    if (timeMatch !== null && duration > 0) {
      const [, hours = '0', minutes = '0', rest = '0'] = timeMatch;
      onProgress(Math.min(100, Math.floor((seconds(hours, minutes, rest) / duration) * 100)));
    }
  });
  if (run.code !== 0) {
    throw new Error(reason(run, temporary, basename(output)));
  }
  onProgress(100);
}

export function createFfmpegConverter(): Converter {
  return {
    async soundCodec({ program, input, signal }: SoundProbe) {
      // `ffmpeg -i <file>` with no output lists the file's streams, then exits 1: that is the probe.
      // Filled in by the lines ffmpeg writes: whether it read the file, and its first sound track.
      const found: { readable: boolean; codec: string | undefined } = {
        readable: false,
        codec: undefined,
      };
      const run = await runFfmpeg(
        program,
        ['-hide_banner', '-nostdin', '-i', input],
        signal,
        (line) => {
          found.readable ||= line.startsWith('Input #0');
          const audio = /^\s*Stream #\d+:\d+\S*: Audio: ([A-Za-z0-9_]+)/.exec(line);
          found.codec ??= audio?.[1];
        },
      );
      if (!found.readable) {
        throw new Error(`ffmpeg could not read the Lesson: ${run.tail.join(' ')}`);
      }
      return found.codec;
    },

    async extractSound(request) {
      const { output, signal } = request;
      signal.throwIfAborted();
      await sweepStaleParts(dirname(output));
      conversions += 1;
      const temporary = join(
        dirname(output),
        `.${basename(output)}.${String(process.pid)}-${String(conversions)}.part`,
      );
      try {
        await createTemporary(temporary);
        await convert(request, temporary);
        await rename(temporary, output);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}
