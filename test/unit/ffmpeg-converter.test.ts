/**
 * The Converter port over ffmpeg (spec #12, Sound for MP4 Lessons; ADR 0034, ADR 0056, ADR 0057):
 * what the real adapter does with a Lesson's sound and with the ffmpeg process, through the port's
 * own interface. Only the process is stood in for, because what it writes (recorded from a real
 * ffmpeg in test/fixtures/probe, by scripts/make-probe-fixtures.mjs) and how it ends are all the
 * adapter sees: CI has no ffmpeg, and a real one could not be made to hang on cue.
 *
 * A recorded exception to "tests only at the three seams" (D11 on #12), on the orchestrator's
 * conditions: it reaches the adapter only through what `createFfmpegConverter` returns (the
 * Converter port), fakes only the spawned process, and asserts only what that port or the faked
 * process boundary shows: progress, results, error text, files on disk, and the signals and
 * arguments the process receives; never a private function.
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  createFfmpegConverter,
  type ConverterOptions,
  type FfmpegProcess,
  type StartFfmpeg,
} from '../../src/adapters/node/converter.js';
import { FileSystemError, type Converter } from '../../src/core/ports.js';
import { makeReadOnly } from './read-only.js';

/** A short stand-in for the seconds ffmpeg gets between being asked to stop and being killed. */
const grace = 25;

/** What a stand-in ffmpeg does when the converter signals it. */
type Obeys = readonly ('SIGTERM' | 'SIGKILL')[];

/** The process ids the stand-in ffmpegs get, one each. */
let nextPid = 4000;

class FakeFfmpeg extends EventEmitter implements FfmpegProcess {
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  readonly pid = nextPid++;

  constructor(
    readonly args: readonly string[],
    private readonly obeys: Obeys,
  ) {
    super();
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    this.signals.push(signal);
    if (this.obeys.includes(signal)) {
      setImmediate(() => {
        this.finish(null);
      });
    }
    return true;
  }

  /** ffmpeg writes `text` to its error output. */
  say(text: string): void {
    this.stderr.write(text);
  }

  /** ffmpeg exits. */
  finish(code: number | null): void {
    this.stderr.end();
    // After the error output was read, as a real process closes after its streams end.
    setImmediate(() => {
      this.emit('close', code);
    });
  }
}

interface Fixture {
  readonly converter: Converter;
  /** Every process the converter started, oldest first. */
  readonly started: FakeFfmpeg[];
}

/** A converter whose ffmpeg is `behave`: it is given each process the converter starts. */
function converterRunning(
  behave: (process: FakeFfmpeg) => void,
  obeys: Obeys = ['SIGTERM', 'SIGKILL'],
  options: ConverterOptions = {},
): Fixture {
  const started: FakeFfmpeg[] = [];
  const start: StartFfmpeg = (_program, args) => {
    const process = new FakeFfmpeg(args, obeys);
    started.push(process);
    setImmediate(() => {
      behave(process);
    });
    return process;
  };
  return {
    converter: createFfmpegConverter({ start, killGraceMs: grace, ...options }),
    started,
  };
}

const recorded = (name: string): Promise<string> =>
  readFile(join(__dirname, '..', 'fixtures', 'probe', `${name}.txt`), 'utf8');

/** A converter whose ffmpeg writes the recorded `name` output of a probe and exits like ffmpeg. */
function converterProbing(name: string): Fixture {
  return converterRunning((process) => {
    void recorded(name).then((text) => {
      process.say(text);
      process.finish(1);
    });
  });
}

const never = new AbortController().signal;
let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'followalong-converter-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('the sound codec of a Lesson, as ffmpeg lists it', () => {
  const probe = (name: string) =>
    converterProbing(name).converter.soundCodec({
      program: 'ffmpeg',
      input: join(folder, 'Lesson.mp4'),
      signal: never,
    });

  it('is AAC for the sound of a typical MP4 Lesson', async () => {
    await expect(probe('aac')).resolves.toBe('aac');
  });

  it('is MP3 for an MP4 whose sound the page decodes itself', async () => {
    await expect(probe('mp3')).resolves.toBe('mp3');
  });

  it('is nothing for a video with no sound', async () => {
    await expect(probe('silent')).resolves.toBeUndefined();
  });

  it('is the first sound track when there are two, the one that is converted', async () => {
    await expect(probe('two-tracks')).resolves.toBe('mp3');
  });

  it('fails, with what ffmpeg said, for a file it cannot read', async () => {
    await expect(probe('unreadable')).rejects.toThrow(
      /ffmpeg could not read the Lesson: .*Invalid data found when processing input/,
    );
  });

  it('says where to get ffmpeg when it is not there', async () => {
    const { converter } = converterRunning((process) => {
      process.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
      process.finish(null);
    });

    await expect(
      converter.soundCodec({ program: 'ffmpeg', input: join(folder, 'Lesson.mp4'), signal: never }),
    ).rejects.toThrow(
      'ffmpeg was not found (ffmpeg). Install ffmpeg, or set followalong.ffmpegPath to it.',
    );
  });

  it('asks ffmpeg for the stream list only, through an argument array with the file as one item', async () => {
    const { converter, started } = converterProbing('aac');
    const input = join(folder, 'A "quoted" Lesson; rm -rf $HOME.mp4');

    await converter.soundCodec({ program: 'ffmpeg', input, signal: never });

    expect(started[0]?.args).toEqual(['-hide_banner', '-nostdin', '-i', input]);
  });
});

describe('the length of a Lesson, as ffmpeg lists it', () => {
  const length = (name: string) =>
    converterProbing(name).converter.lessonLength({
      program: 'ffmpeg',
      input: join(folder, 'Lesson.mp4'),
      signal: never,
    });

  it('is the seconds ffmpeg reports for the video', async () => {
    await expect(length('aac')).resolves.toBe(1);
  });

  it('is unknown, not 0, for a WebM whose length ffmpeg reports as N/A', async () => {
    await expect(length('no-duration')).resolves.toBeUndefined();
  });

  it('fails, with what ffmpeg said, for a file it cannot read', async () => {
    await expect(length('unreadable')).rejects.toThrow(
      /^ffmpeg could not read the Lesson: .*Invalid data found when processing input/,
    );
  });

  it('asks ffmpeg for the stream list only, through an argument array with the file as one item', async () => {
    const { converter, started } = converterProbing('aac');
    const input = join(folder, 'A "quoted" Lesson; rm -rf $HOME.mp4');

    await converter.lessonLength({ program: 'ffmpeg', input, signal: never });

    expect(started[0]?.args).toEqual(['-hide_banner', '-nostdin', '-i', input]);
  });

  it('stops ffmpeg when asked to, as the sound probe does', async () => {
    const { converter, started } = converterRunning(() => undefined, ['SIGKILL']);
    const stop = new AbortController();
    const probing = converter.lessonLength({
      program: 'ffmpeg',
      input: join(folder, 'Lesson.mp4'),
      signal: stop.signal,
    });
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });

    stop.abort();

    await expect(probing).rejects.toThrow();
    expect(started[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('stopping ffmpeg', () => {
  const lesson = () => ({ program: 'ffmpeg', input: join(folder, 'Lesson.mp4') });

  it('asks ffmpeg to stop once, and nothing more when it does', async () => {
    const { converter, started } = converterRunning(() => undefined);
    const stop = new AbortController();
    const probing = converter.soundCodec({ ...lesson(), signal: stop.signal });
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });

    stop.abort();

    await expect(probing).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, grace * 3));
    expect(started[0]?.signals).toEqual(['SIGTERM']);
  });

  it('kills ffmpeg when it ignores the request, as it does while blocked reading a stalled mount', async () => {
    const { converter, started } = converterRunning(() => undefined, ['SIGKILL']);
    const stop = new AbortController();
    const probing = converter.soundCodec({ ...lesson(), signal: stop.signal });
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });

    stop.abort();

    await expect(probing).rejects.toThrow();
    expect(started[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('gives up waiting for an ffmpeg that cannot even be killed, so nothing waits for ever', async () => {
    const { converter, started } = converterRunning(() => undefined, []);
    const stop = new AbortController();
    const probing = converter.soundCodec({ ...lesson(), signal: stop.signal });
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });

    stop.abort();

    await expect(probing).rejects.toThrow();
    expect(started[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not start ffmpeg for a Lesson that was left already', async () => {
    const { converter, started } = converterRunning(() => undefined);
    const stop = new AbortController();
    stop.abort();

    await expect(converter.soundCodec({ ...lesson(), signal: stop.signal })).rejects.toThrow();
    expect(started).toEqual([]);
  });

  it('leaves no temp file behind when a conversion is stopped', async () => {
    const { converter, started } = converterRunning(() => undefined);
    const stop = new AbortController();
    const output = join(folder, 'Lesson-0123456789abcdef.mp3');
    const converting = converter.extractSound({
      ...lesson(),
      output,
      lowPriority: false,
      onProgress: () => undefined,
      signal: stop.signal,
    });
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });

    stop.abort();

    await expect(converting).rejects.toThrow();
    expect(await readdir(folder)).toEqual([]);
  });
});

describe('converting the sound', () => {
  it('writes the MP3 whole, reports the progress ffmpeg gives, and runs ffmpeg without a shell', async () => {
    const input = join(folder, 'A "quoted" Lesson; rm -rf $HOME.mp4');
    const output = join(folder, 'Lesson-0123456789abcdef.mp3');
    const { converter, started } = converterRunning((process) => {
      void recorded('convert-aac').then((text) => {
        const [temporary] = process.args.slice(-1);
        process.say(text.replace('size=       0kB', 'size=       2kB time=00:00:00.50 bitrate=1'));
        void writeFile(temporary ?? '', 'ID3 mp3 sound').then(() => {
          process.finish(0);
        });
      });
    });
    const percents: number[] = [];

    await converter.extractSound({
      program: 'ffmpeg',
      input,
      output,
      lowPriority: false,
      onProgress: (percent) => percents.push(percent),
      signal: never,
    });

    expect(percents).toEqual([50, 100, 100]);
    expect(await readFile(output, 'utf8')).toBe('ID3 mp3 sound');
    expect(await readdir(folder)).toEqual(['Lesson-0123456789abcdef.mp3']);
    const args = started[0]?.args ?? [];
    expect(args).toContain(input);
    expect(args.slice(0, 5)).toEqual(['-hide_banner', '-nostdin', '-y', '-i', input]);
  });

  it('still reports progress while ffmpeg converts a Lesson whose length it cannot read, so it is not taken for stalled', async () => {
    const output = join(folder, 'Lesson-0123456789abcdef.mp3');
    const { converter } = converterRunning((process) => {
      const [temporary] = process.args.slice(-1);
      process.say('  Duration: N/A, bitrate: N/A\n');
      process.say('size=      10kB time=00:00:02.00 bitrate=  40.0kbits/s speed=50x    \r');
      process.say('size=      20kB time=00:00:04.00 bitrate=  40.0kbits/s speed=50x    \r');
      void writeFile(temporary ?? '', 'ID3 mp3 sound').then(() => {
        process.finish(0);
      });
    });
    const percents: number[] = [];

    await converter.extractSound({
      program: 'ffmpeg',
      input: join(folder, 'Lesson.mp4'),
      output,
      lowPriority: false,
      onProgress: (percent) => percents.push(percent),
      signal: never,
    });

    // One report per progress line from ffmpeg, then the end: 0 is "alive, length unknown".
    expect(percents).toEqual([0, 0, 100]);
  });

  it('never shows the temp file’s own name either, in whatever form ffmpeg writes it', async () => {
    const { converter } = converterRunning((process) => {
      const [temporary] = process.args.slice(-1);
      const name = (temporary ?? '').split(/[\\/]/).at(-1) ?? '';
      process.say(`Unable to rename ${name}: Permission denied\n`);
      process.finish(1);
    });

    const failure = await converter
      .extractSound({
        program: 'ffmpeg',
        input: join(folder, 'Lesson.mp4'),
        output: join(folder, 'Lesson-0123456789abcdef.mp3'),
        lowPriority: false,
        onProgress: () => undefined,
        signal: never,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(String(failure)).toContain('Unable to rename Lesson-0123456789abcdef.mp3');
    expect(String(failure)).not.toContain('.part');
  });

  it('fails with ffmpeg’s own words, without the name of its temp file', async () => {
    const { converter } = converterRunning((process) => {
      const [temporary] = process.args.slice(-1);
      process.say(`Error opening output file ${temporary ?? ''}: Input/output error\n`);
      process.finish(1);
    });

    const failure = await converter
      .extractSound({
        program: 'ffmpeg',
        input: join(folder, 'Lesson.mp4'),
        output: join(folder, 'Lesson-0123456789abcdef.mp3'),
        lowPriority: false,
        onProgress: () => undefined,
        signal: never,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(String(failure)).toContain('Error opening output file Lesson-0123456789abcdef.mp3');
    expect(String(failure)).not.toContain('.part');
    expect(await readdir(folder)).toEqual([]);
  });
});

describe('what the learner is told when the output cannot be written', () => {
  const extract = (output: string) =>
    converterRunning(() => undefined).converter.extractSound({
      program: 'ffmpeg',
      input: join(folder, 'Lesson.mp4'),
      output,
      lowPriority: false,
      onProgress: () => undefined,
      signal: never,
    });

  it('never names the temp file when the Lesson’s file name is too long for the folder', async () => {
    const failure = await extract(join(folder, `${'n'.repeat(250)}.mp3`)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('.part');
    expect(String(failure)).not.toContain(folder);
  });

  it('never names the temp file when the folder is read-only, and still says it is read-only', async () => {
    const sound = join(folder, 'sound');
    await mkdir(sound);
    const writable = makeReadOnly(sound);

    const failure = await extract(join(sound, 'Lesson-0123456789abcdef.mp3')).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Before the folder is removed, which a read-only one cannot be.
    writable();

    expect(FileSystemError.is(failure, 'readOnly')).toBe(true);
    expect(String(failure)).not.toContain('.part');
  });
});

describe('temp files a conversion that died with its window left behind', () => {
  const minute = 60 * 1000;

  /** A temp file as an earlier conversion leaves it, last written `agoMs` before the real time. */
  async function leftBehind(name: string, agoMs: number): Promise<void> {
    const path = join(folder, name);
    await writeFile(path, 'half a sound');
    const at = new Date(Date.now() - agoMs);
    await utimes(path, at, at);
  }

  const convert = () => {
    const { converter } = converterRunning((process) => {
      process.finish(0);
    });
    return converter.extractSound({
      program: 'ffmpeg',
      input: join(folder, 'Lesson.mp4'),
      output: join(folder, 'Lesson-0123456789abcdef.mp3'),
      lowPriority: false,
      onProgress: () => undefined,
      signal: never,
    });
  };

  it('are removed once 10 minutes untouched, and kept while a conversion may still write them', async () => {
    await leftBehind('.Old-0123456789abcdef.mp3.4242-1.part', 11 * minute);
    await leftBehind('.Live-0123456789abcdef.mp3.4343-1.part', minute);
    await writeFile(join(folder, '.hidden-notes'), 'not a temp file');

    await convert();

    expect((await readdir(folder)).sort()).toEqual([
      '.Live-0123456789abcdef.mp3.4343-1.part',
      '.hidden-notes',
      'Lesson-0123456789abcdef.mp3',
    ]);
  });

  it('are judged by the clock of the folder’s own files, not by the clock of this machine', async () => {
    // A network folder's server writes its own times. Here this machine's clock is two hours ahead
    // of the folder's: judged against it, the conversion another window is running looks 2 hours old.
    await leftBehind('.Live-0123456789abcdef.mp3.4343-1.part', minute);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 120 * minute);
    onTestFinished(() => {
      vi.useRealTimers();
    });

    await convert();

    expect(await readdir(folder)).toContain('.Live-0123456789abcdef.mp3.4343-1.part');
  });
});

describe('low process priority', () => {
  const convert = (converter: Converter, lowPriority: boolean): Promise<void> =>
    converter.extractSound({
      program: 'ffmpeg',
      input: join(folder, 'Lesson.mp4'),
      output: join(folder, 'Lesson-0123456789abcdef.mp3'),
      lowPriority,
      onProgress: () => undefined,
      signal: never,
    });

  /** ffmpeg writes its sound and exits. */
  const finishing = (process: FakeFfmpeg): void => {
    const [temporary] = process.args.slice(-1);
    void writeFile(temporary ?? '', 'ID3 mp3 sound').then(() => {
      process.finish(0);
    });
  };

  it('runs the ffmpeg it started below normal priority when asked to', async () => {
    const lowered: [number, number][] = [];
    const { converter, started } = converterRunning(finishing, ['SIGTERM', 'SIGKILL'], {
      setPriority: (pid, priority) => {
        lowered.push([pid, priority]);
      },
    });

    await convert(converter, true);

    expect(lowered).toEqual([[started[0]?.pid, osConstants.priority.PRIORITY_BELOW_NORMAL]]);
  });

  it('leaves the priority of the ffmpeg alone when not asked to lower it', async () => {
    const lowered: number[] = [];
    const { converter } = converterRunning(finishing, ['SIGTERM', 'SIGKILL'], {
      setPriority: (pid) => {
        lowered.push(pid);
      },
    });

    await convert(converter, false);

    expect(lowered).toEqual([]);
  });

  it('still converts when the system will not lower the priority', async () => {
    const { converter } = converterRunning(finishing, ['SIGTERM', 'SIGKILL'], {
      setPriority: () => {
        throw new Error('EPERM: operation not permitted');
      },
    });

    await convert(converter, true);

    expect(await readFile(join(folder, 'Lesson-0123456789abcdef.mp3'), 'utf8')).toBe(
      'ID3 mp3 sound',
    );
  });
});
