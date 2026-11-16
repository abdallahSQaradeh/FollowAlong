/**
 * The Converter port over ffmpeg (the audio sidecar, ADR 0034). It runs the program the core
 * chose (`followalong.ffmpegPath`, or ffmpeg on PATH until the bundled one lands), takes the
 * Lesson's first sound track only, and encodes it as MP3. ffmpeg writes a temp file beside the
 * output, renamed over it once whole, so a conversion cut short never looks like a finished one.
 */
import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { ConversionRequest, Converter } from '../../core/ports.js';

/** The last lines of ffmpeg's error output kept for the reason of a failure. */
const reasonLines = 3;

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

function run(request: ConversionRequest, temporary: string): Promise<void> {
  const { program, input, onProgress, signal } = request;
  return new Promise((resolve, reject) => {
    const child = spawn(program, soundArguments(input, temporary), {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      signal,
    });
    let duration = 0;
    let tail: string[] = [];
    let pending = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // ffmpeg ends its progress lines with \r, other lines with \n.
      const lines = (pending + chunk).split(/\r\n|\r|\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const durationMatch = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
        if (durationMatch !== null && duration === 0) {
          const [, hours = '0', minutes = '0', rest = '0'] = durationMatch;
          duration = seconds(hours, minutes, rest);
        }
        const timeMatch = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
        if (timeMatch !== null && duration > 0) {
          const [, hours = '0', minutes = '0', rest = '0'] = timeMatch;
          const at = seconds(hours, minutes, rest);
          onProgress(Math.min(100, Math.floor((at / duration) * 100)));
        }
        if (line.trim() !== '') {
          tail = [...tail, line.trim()].slice(-reasonLines);
        }
      }
    });
    child.on('error', (error) => {
      const code = 'code' in error ? error.code : undefined;
      reject(
        code === 'ENOENT'
          ? new Error(
              `ffmpeg was not found (${program}). Install ffmpeg, or set followalong.ffmpegPath to it.`,
            )
          : error,
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        onProgress(100);
        resolve();
      } else if (!signal.aborted) {
        reject(new Error(`ffmpeg exited with code ${String(code)}: ${tail.join(' ')}`));
      }
    });
  });
}

export function createFfmpegConverter(): Converter {
  return {
    async extractSound(request) {
      const { output, signal } = request;
      signal.throwIfAborted();
      const temporary = join(dirname(output), `.${basename(output)}.${String(process.pid)}.part`);
      try {
        await run(request, temporary);
        await rename(temporary, output);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}
