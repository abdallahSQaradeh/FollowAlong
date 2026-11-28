/**
 * The Converter port over ffmpeg (the audio sidecar, ADR 0034). It runs the program the core
 * chose (`followalong.ffmpegPath`, the ffmpeg the .vsix ships, or ffmpeg on PATH; ADR 0071),
 * always with an argument array and never through a shell. It reads which sound a Lesson has, and
 * converts the first sound track to MP3. ffmpeg writes a temp file beside the output, renamed over it once
 * whole, so a conversion cut short never looks like a finished one. It stops an ffmpeg it was told
 * to stop, with SIGKILL when SIGTERM is not enough, and gives up waiting for one that cannot be
 * killed (ADR 0056). What it throws never names its temp file (ADR 0057).
 */
import { spawn } from 'node:child_process';
import { open, readdir, rename, rm, stat } from 'node:fs/promises';
import { constants as osConstants, setPriority as setProcessPriority } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';

import {
  FileSystemError,
  type ConversionRequest,
  type Converter,
  type LessonProbe,
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

/**
 * The input's length in seconds when `line` is the one where ffmpeg lists it
 * (`Duration: HH:MM:SS.xx`); `undefined` for any other line, and for `Duration: N/A`.
 */
function durationOf(line: string): number | undefined {
  const match = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  if (match === null) {
    return undefined;
  }
  const [, hours = '0', minutes = '0', rest = '0'] = match;
  return seconds(hours, minutes, rest);
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

/** The part of a child process the converter uses: what a test stands in for ffmpeg with. */
export interface FfmpegProcess {
  /** The process id, once the process started; `undefined` when it could not be. */
  readonly pid?: number | undefined;
  /** What ffmpeg writes to its error output, where it reports. */
  readonly stderr: Readable;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(signal: 'SIGTERM' | 'SIGKILL'): unknown;
}

/** Starts ffmpeg, through an argument array and never a shell. */
export type StartFfmpeg = (program: string, args: readonly string[]) => FfmpegProcess;

export interface ConverterOptions {
  /** Starts the process: `child_process.spawn` unless a test stands in for ffmpeg. */
  readonly start?: StartFfmpeg;
  /**
   * Sets the priority of a process: `os.setPriority` unless a test stands in for the system. A
   * conversion the core asked to run at low priority gets `PRIORITY_BELOW_NORMAL`, which is a
   * nice value on macOS and Linux and BELOW_NORMAL_PRIORITY_CLASS on Windows.
   */
  readonly setPriority?: (pid: number, priority: number) => void;
  /**
   * How long a stopped ffmpeg gets to exit, and then, once killed, to be gone, before the stop is
   * settled anyway.
   */
  readonly killGraceMs?: number;
}

const startProcess: StartFfmpeg = (program, args) =>
  spawn(program, [...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

/**
 * A single SIGTERM does not end ffmpeg while it is blocked opening a file on a stalled network mount
 * (or a FIFO): it is killed after this long. A process that survives even that, stuck in the
 * kernel, is waited for no longer than this again.
 */
const defaultKillGraceMs = 5000;

/** The reason a stopped run rejects with. */
function stopReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('ffmpeg was stopped.');
}

/**
 * Runs ffmpeg and hands each line of its error output (where it reports) to `onLine`. Resolves
 * once ffmpeg has exited, whatever its code: on Windows a file a running ffmpeg still holds cannot
 * be removed, so a cancel or a failure must wait for it before cleaning up. Rejects when ffmpeg
 * cannot be started, or `signal` stopped it: ffmpeg is asked to stop (SIGTERM), then killed, and
 * the run settles when it has exited, or once it has had time to after the kill. With
 * `lowPriority`, ffmpeg runs below normal priority, so a conversion never slows the machine down.
 */
function runFfmpeg(
  { start, killGraceMs, setPriority }: Required<ConverterOptions>,
  program: string,
  args: readonly string[],
  signal: AbortSignal,
  lowPriority: boolean,
  onLine: (line: string) => void,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = start(program, args);
    if (lowPriority && child.pid !== undefined) {
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // A process that ended already, or one the system will not let us change: the sound is
        // converted at normal priority, which is slower for the machine but never a failure.
      }
    }
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
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const settle = (action: () => void): void => {
      if (!settled) {
        settled = true;
        timers.forEach(clearTimeout);
        signal.removeEventListener('abort', stop);
        action();
      }
    };
    function stop(): void {
      failure ??= stopReason(signal);
      child.kill('SIGTERM');
      timers.push(
        setTimeout(() => {
          child.kill('SIGKILL');
          timers.push(
            setTimeout(() => {
              settle(() => {
                reject(failure ?? stopReason(signal));
              });
            }, killGraceMs),
          );
        }, killGraceMs),
      );
    }
    signal.addEventListener('abort', stop, { once: true });
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
      settle(() => {
        if (failure === undefined) {
          resolve({ code, tail });
        } else {
          reject(failure);
        }
      });
    });
  });
}

/** The reason ffmpeg gave, without the name of a temp file the learner never sees. */
function reason(run: Run, temporary: string, shownAs: string): string {
  return `ffmpeg exited with code ${String(run.code)}: ${withoutTemporary(run.tail.join(' '), temporary, shownAs)}`;
}

/**
 * `text` with the temp file named as the sound file instead, whether it is written with its folder
 * (in any spelling of it) or by its own name, which is unique to the run.
 */
function withoutTemporary(text: string, temporary: string, shownAs: string): string {
  return text.replaceAll(temporary, shownAs).replaceAll(basename(temporary), shownAs);
}

/**
 * Removes temp files that conversions which died with their window left in `folder`. "Untouched
 * for 10 minutes" is measured against `reference`, a file just made in the same folder, not against
 * this machine's clock: a network folder stamps files with its own server's clock, which may be
 * hours away from ours (ADR 0057).
 */
async function sweepStaleParts(folder: string, reference: string): Promise<void> {
  const now = await stat(reference).then(
    (found) => found.mtimeMs,
    () => undefined,
  );
  if (now === undefined) {
    return;
  }
  const names = await readdir(folder).catch(() => []);
  for (const name of names.filter((entry) => entry.startsWith('.') && entry.endsWith('.part'))) {
    const path = join(folder, name);
    if (path === reference) {
      continue;
    }
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
      throw new FileSystemError('readOnly', dirname(temporary), 'the folder is read-only');
    }
    throw error;
  }
}

/** Numbers the temp files, so a new conversion never writes where a cancelled one may still be. */
let conversions = 0;

/**
 * What the learner may read of a failure to write the sound: plain words, never the name of the
 * temp file, which they never see and cannot act on.
 */
function plainFailure(error: unknown, temporary: string, output: string): unknown {
  if (!(error instanceof Error) || error instanceof FileSystemError) {
    return error;
  }
  const code = 'code' in error ? error.code : undefined;
  switch (code) {
    case 'ENAMETOOLONG':
      return new Error(
        `the file name of the sound is too long for this folder (${basename(output)})`,
      );
    case 'ENOSPC':
      return new Error('the disk is full');
    default:
      return new Error(withoutTemporary(error.message, temporary, basename(output)), {
        cause: error,
      });
  }
}

async function convert(
  runner: Required<ConverterOptions>,
  request: ConversionRequest,
  temporary: string,
): Promise<void> {
  const { program, input, output, onProgress, signal } = request;
  let duration = 0;
  const run = await runFfmpeg(
    runner,
    program,
    soundArguments(input, temporary),
    signal,
    request.lowPriority,
    (line) => {
      if (duration === 0) {
        duration = durationOf(line) ?? 0;
      }
      const timeMatch = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
      if (timeMatch !== null) {
        const [, hours = '0', minutes = '0', rest = '0'] = timeMatch;
        // A Lesson whose length ffmpeg cannot read still reports 0: the core takes no progress for
        // 60 s to mean the conversion is stuck (ADR 0056).
        onProgress(
          duration > 0
            ? Math.min(100, Math.floor((seconds(hours, minutes, rest) / duration) * 100))
            : 0,
        );
      }
    },
  );
  if (run.code !== 0) {
    throw new Error(reason(run, temporary, basename(output)));
  }
  onProgress(100);
}

/**
 * Runs `ffmpeg -i <file>` with no output, which lists the file's streams and exits 1: the probe.
 * `onLine` is given each line ffmpeg writes. Rejects when ffmpeg could not read the file.
 */
async function readStreams(
  runner: Required<ConverterOptions>,
  { program, input, signal }: LessonProbe,
  onLine: (line: string) => void,
): Promise<void> {
  const found = { readable: false };
  const run = await runFfmpeg(
    runner,
    program,
    ['-hide_banner', '-nostdin', '-i', input],
    signal,
    false,
    (line) => {
      found.readable ||= line.startsWith('Input #0');
      onLine(line);
    },
  );
  if (!found.readable) {
    throw new Error(`ffmpeg could not read the Lesson: ${run.tail.join(' ')}`);
  }
}

export function createFfmpegConverter(options: ConverterOptions = {}): Converter {
  const runner: Required<ConverterOptions> = {
    start: options.start ?? startProcess,
    killGraceMs: options.killGraceMs ?? defaultKillGraceMs,
    setPriority: options.setPriority ?? setProcessPriority,
  };
  return {
    async soundCodec(probe) {
      // Filled in by the lines ffmpeg writes: the codec of its first sound track.
      const found: { codec: string | undefined } = { codec: undefined };
      await readStreams(runner, probe, (line) => {
        const audio = /^\s*Stream #\d+:\d+\S*: Audio: ([A-Za-z0-9_]+)/.exec(line);
        found.codec ??= audio?.[1];
      });
      return found.codec;
    },

    async lessonLength(probe) {
      // Filled in by the first `Duration:` line. `Duration: N/A` does not match, so stays unknown.
      const found: { length: number | undefined } = { length: undefined };
      await readStreams(runner, probe, (line) => {
        found.length ??= durationOf(line);
      });
      // The one place the "a length of 0 is unknown" rule is kept: the port never reports 0.
      return found.length !== undefined && found.length > 0 ? found.length : undefined;
    },

    async extractSound(request) {
      const { output, signal } = request;
      signal.throwIfAborted();
      conversions += 1;
      const temporary = join(
        dirname(output),
        `.${basename(output)}.${String(process.pid)}-${String(conversions)}.part`,
      );
      try {
        await createTemporary(temporary);
        await sweepStaleParts(dirname(output), temporary);
        await convert(runner, request, temporary);
        await rename(temporary, output);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw plainFailure(error, temporary, output);
      }
    },
  };
}
