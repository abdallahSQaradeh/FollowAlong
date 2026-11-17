/**
 * The audio cache limit (spec #12, Sound for MP4 Lessons, story 74; ticket #45): prepared sound
 * files are capped (5 GB by default), and the Lessons opened longest ago are deleted first. The fake
 * converter writes 13-byte MP3s, so a limit of a few dozen bytes stands for a small disk.
 */
import { readdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, fakeSound, type Harness } from './harness.js';
import { makeReadOnly } from './read-only.js';

const mp3Bytes = fakeSound.length;
const bytesPerGb = 1024 ** 3;

/** The setting is in GB: this is the value that stands for `bytes`. */
function limitOf(bytes: number): number {
  return bytes / bytesPerGb;
}

/** The Lessons of a Course of `count` MP4 Lessons: `01 Lesson.mp4`, `02 Lesson.mp4`, … */
function lessons(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${String(index + 1).padStart(2, '0')} Lesson.mp4`,
      `mp4 video ${String(index + 1)}`,
    ]),
  );
}

/** Opens a Course in a player that cannot decode AAC. Returns the Course folder. */
async function openCourse(h: Harness, name: string, count: number): Promise<string> {
  const course = await h.folder(name, lessons(count));
  await h.core.openCourse(course);
  h.player.ready(false);
  await h.settle();
  return course;
}

type Conversion = Harness['converter']['requests'][number];

/** The conversions already finished: finishing one again would write its file again. */
const finished = new WeakSet<Conversion>();

/** Succeeds `conversion` once, as ffmpeg finishing it does. */
async function finish(conversion: Conversion | undefined): Promise<void> {
  if (conversion !== undefined && !finished.has(conversion)) {
    finished.add(conversion);
    await conversion.succeed();
  }
}

/** Succeeds every conversion that is waiting, and those the queue starts after them. */
async function finishAll(h: Harness): Promise<void> {
  for (let index = 0; ; index += 1) {
    await h.settle();
    const next = h.converter.requests[index];
    if (next === undefined) {
      return;
    }
    await finish(next);
  }
}

/** The numbers of the Lessons whose sound is kept in `folder`'s Course data, in order. */
async function kept(course: string): Promise<string[]> {
  const folder = join(course, '.followalong', 'sound');
  const names = await readdir(folder).catch(() => []);
  return names
    .filter((name) => name.endsWith('.mp3'))
    .map((name) => name.slice(0, 2))
    .sort();
}

/** The Lessons whose sound is kept in the extension's own storage, as the Courses' numbers. */
async function keptInStorage(h: Harness): Promise<string[]> {
  const root = join(h.storage.folder, 'courses');
  const courses = await readdir(root).catch(() => []);
  const names = await Promise.all(
    courses.map((course) => readdir(join(root, course, 'sound')).catch(() => [])),
  );
  return names
    .flat()
    .filter((name) => name.endsWith('.mp3'))
    .map((name) => name.slice(0, 2))
    .sort();
}

/** The name of the file that holds Lesson `number`'s sound in `course`'s sound folder. */
async function soundOf(course: string, number: string): Promise<string> {
  const names = await readdir(join(course, '.followalong', 'sound'));
  const found = names.find((name) => name.startsWith(number));
  if (found === undefined) {
    throw new Error(`No sound file for Lesson ${number}`);
  }
  return found;
}

describe('the audio cache limit', () => {
  it('deletes the sound of the Lessons opened longest ago first, until it is under the limit', async () => {
    const h = await createHarness();
    h.config.set('audioCacheLimit', limitOf(5 * mp3Bytes));
    const course = await openCourse(h, 'course', 8);
    await finishAll(h);
    expect(await kept(course)).toEqual(['01', '02', '03', '04']);
    h.clock.advance(60_000);

    h.core.playLesson('06 Lesson.mp4');
    await finishAll(h);

    // 06 to 08 are in use or next; of the rest, 01 and 02 were opened longest ago.
    expect(await kept(course)).toEqual(['03', '04', '06', '07', '08']);
    expect(h.ui.messages).toEqual([]);
  });

  it('counts the sound of every Course, in its folder and in the extension’s own storage', async () => {
    const h = await createHarness();
    h.config.set('audioCacheLimit', limitOf(mp3Bytes));
    const first = await openCourse(h, 'first', 1);
    await finishAll(h);
    expect(await kept(first)).toEqual(['01']);
    h.clock.advance(60_000);

    // A read-only Course keeps its sound in the extension's storage; the older sound of the first
    // Course, in its own folder, makes way for it.
    const second = await h.folder('second', lessons(1));
    makeReadOnly(second);
    await h.core.openCourse(second);
    h.player.ready(false);
    await h.settle();
    await finishAll(h);
    expect(await kept(first)).toEqual([]);
    expect(await keptInStorage(h)).toEqual(['01']);
    h.clock.advance(60_000);

    // And the other way round: a Course with a writable folder pushes out older sound in storage.
    const third = await openCourse(h, 'third', 1);
    await finishAll(h);
    expect(await keptInStorage(h)).toEqual([]);
    expect(await kept(third)).toEqual(['01']);
    expect(h.ui.messages).toEqual([]);
  });

  it('never deletes the sound of the Lesson that is loaded or of the next Lessons being prepared', async () => {
    const h = await createHarness();
    // Not even one file fits: only what is in use stays.
    h.config.set('audioCacheLimit', 0);
    const course = await openCourse(h, 'course', 6);
    await finishAll(h);

    // The opened Lesson and the 3 after it are all in use.
    expect(await kept(course)).toEqual(['01', '02', '03', '04']);
    h.clock.advance(60_000);

    h.core.playLesson('06 Lesson.mp4');
    await finishAll(h);

    expect(await kept(course)).toEqual(['06']);
    const ready = h.player.sent.filter((command) => command.type === 'soundReady');
    expect(ready.at(-1)).toEqual({
      type: 'soundReady',
      audioUri: h.player.resourceUri(
        join(course, '.followalong', 'sound', await soundOf(course, '06')),
      ),
    });
  });
});

describe('the audio cache limit setting', () => {
  it('is 5 GB until it is changed, and a value that is no number of GB means 5 GB', async () => {
    const h = await createHarness();
    const course = await openCourse(h, 'course', 8);
    await finishAll(h);
    for (const bad of [-1, Number.NaN, 'a lot', null]) {
      h.config.set('audioCacheLimit', bad);
    }
    h.core.playLesson('06 Lesson.mp4');
    await finishAll(h);

    expect(await kept(course)).toEqual(['01', '02', '03', '04', '06', '07', '08']);
  });

  it('takes effect at once when it is lowered, without a new conversion', async () => {
    const h = await createHarness();
    const course = await openCourse(h, 'course', 8);
    await finishAll(h);
    h.clock.advance(60_000);
    h.core.playLesson('06 Lesson.mp4');
    await finishAll(h);
    expect(await kept(course)).toEqual(['01', '02', '03', '04', '06', '07', '08']);
    const conversions = h.converter.requests.length;

    h.config.set('audioCacheLimit', limitOf(5 * mp3Bytes));
    await h.settle();

    expect(await kept(course)).toEqual(['03', '04', '06', '07', '08']);
    expect(h.converter.requests).toHaveLength(conversions);
  });
});

describe('sound the audio cache has not seen made', () => {
  it('counts the sound files it finds in the open Course and in its storage, by when they were made', async () => {
    const h = await createHarness();
    // Sound made by an earlier FollowAlong, or in a copy of the Course: it is not in the record.
    const course = await h.folder('course', {
      ...lessons(2),
      '.followalong/sound/old-0123456789abcdef.mp3': fakeSound,
      '.followalong/sound/older-0123456789abcdef.mp3': fakeSound,
    });
    const day = 24 * 3600;
    await utimes(
      join(course, '.followalong', 'sound', 'old-0123456789abcdef.mp3'),
      100 * day,
      100 * day,
    );
    await utimes(
      join(course, '.followalong', 'sound', 'older-0123456789abcdef.mp3'),
      50 * day,
      50 * day,
    );
    h.config.set('audioCacheLimit', limitOf(3 * mp3Bytes));

    await h.core.openCourse(course);
    h.player.ready(false);
    await finishAll(h);

    // 2 Lessons and 2 old files make 4; the one made longest ago goes.
    const names = await readdir(join(course, '.followalong', 'sound'));
    expect(
      names
        .filter((name) => name.endsWith('.mp3'))
        .map((name) => name.split('-')[0])
        .sort(),
    ).toEqual(['01 Lesson', '02 Lesson', 'old']);
  });

  it('remembers when each Lesson was opened across restarts of the window', async () => {
    const h = await createHarness();
    h.config.set('audioCacheLimit', limitOf(2 * mp3Bytes));
    const first = await openCourse(h, 'first', 1);
    await finishAll(h);
    h.clock.advance(60_000);
    const second = await openCourse(h, 'second', 1);
    await finishAll(h);
    h.clock.advance(60_000);
    // The first Course is opened again: its sound was made earlier, but opened last.
    await h.core.openCourse(first);
    h.player.ready(false);
    await h.settle();
    h.clock.advance(60_000);

    h.restart();
    const third = await h.folder('third', lessons(1));
    await h.core.openCourse(third);
    h.player.ready(false);
    await finishAll(h);

    expect(await kept(first)).toEqual(['01']);
    expect(await kept(second)).toEqual([]);
    expect(await kept(third)).toEqual(['01']);
  });
});

describe('keeping the audio cache under its limit in the background', () => {
  it('never makes the sound of the opened Lesson wait for the deleting', async () => {
    const h = await createHarness();
    h.config.set('audioCacheLimit', limitOf(4 * mp3Bytes));
    const course = await openCourse(h, 'course', 8);
    await finishAll(h);
    expect(await kept(course)).toEqual(['01', '02', '03', '04']);
    h.clock.advance(60_000);
    const held = h.holdRemovals();

    h.core.playLesson('06 Lesson.mp4');
    await h.settle();
    await finish(h.converter.requests[4]);
    await held.reached;
    await h.settle();

    // The deleting waits on the slow disk; the Lesson's sound is on its way to the player.
    expect(h.player.sent.filter((command) => command.type === 'soundReady')).toHaveLength(2);
    expect(await kept(course)).toEqual(['01', '02', '03', '04', '06']);
    held.release();
    await h.settle();
    expect(await kept(course)).toEqual(['02', '03', '04', '06']);
  });

  it('logs one line, and shows nothing, when sound cannot be deleted', async () => {
    const h = await createHarness();
    h.config.set('audioCacheLimit', 0);
    const course = await openCourse(h, 'course', 6);
    await finishAll(h);
    h.clock.advance(60_000);
    h.failRemovals('EBUSY: resource busy or locked');

    h.core.playLesson('06 Lesson.mp4');
    await finishAll(h);

    // Four old files could not go; the learner is not bothered, and the Lesson plays.
    expect(await kept(course)).toEqual(['01', '02', '03', '04', '06']);
    expect(h.player.sent.filter((command) => command.type === 'soundReady')).toHaveLength(2);
    expect(h.ui.messages).toEqual([]);
    const lines = h.logger.entries.filter((entry) => entry.message.includes('audio cache'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn' });
    expect(lines[0]?.message).toContain('EBUSY');
    expect(lines[0]?.message).toContain('3 more');
  });
});

describe('sound in use while the audio cache is being pruned', () => {
  it('keeps the sound of the Lesson a Course reopens on, even when the limit leaves no room', async () => {
    const h = await createHarness();
    h.config.set('audioCacheLimit', 0);
    const course = await openCourse(h, 'course', 3);
    await finishAll(h);
    const conversions = h.converter.requests.length;
    await h.core.close();

    h.restart();
    await h.core.restoreCourse();
    h.player.ready(false);
    await h.settle();

    // Reopening on the same Lesson finds its sound, and the next Lessons' sound, still there.
    expect(await kept(course)).toEqual(['01', '02', '03']);
    expect(h.converter.requests).toHaveLength(conversions);
  });

  it('keeps the sound of a Lesson the learner opens while the deleting is under way', async () => {
    const h = await createHarness();
    h.config.set('audioCacheLimit', 0);
    const course = await openCourse(h, 'course', 6);
    await finishAll(h);
    h.clock.advance(60_000);
    const held = h.holdRemovals();
    h.core.playLesson('06 Lesson.mp4');
    await h.settle();
    await finish(h.converter.requests[4]);
    await held.reached;

    // The deleting of 01 to 04 is held on a slow disk, and the learner goes back to Lesson 02.
    h.core.playLesson('02 Lesson.mp4');
    await h.settle();
    held.release();
    await h.settle();
    await finishAll(h);

    // Its sound was there when it was opened, and is not made again because it was deleted after.
    const conversionsOf02 = h.converter.requests.filter(({ request }) =>
      request.input.endsWith('02 Lesson.mp4'),
    );
    expect(conversionsOf02).toHaveLength(1);
    expect(await kept(course)).toContain('02');
  });

  it('deletes nothing, and logs one line, when it cannot tell which Lesson is in use', async () => {
    const h = await createHarness();
    const first = await openCourse(h, 'first', 1);
    await finishAll(h);
    h.clock.advance(60_000);
    const second = await openCourse(h, 'second', 1);
    await finishAll(h);
    // The loaded Lesson's file is locked by another program for a moment.
    const lock = join(second, '01 Lesson.mp4');
    h.failStat(lock, 'EBUSY: resource busy or locked');

    h.config.set('audioCacheLimit', 0);
    await h.settle();

    expect(await kept(first)).toEqual(['01']);
    const lines = h.logger.entries.filter((entry) => entry.message.includes('audio cache'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn' });
    expect(lines[0]?.message).toContain('EBUSY');

    // Once it can be looked at again, the older Course's sound goes and the loaded one stays.
    h.restoreStat(lock);
    h.config.set('audioCacheLimit', 0);
    await h.settle();
    expect(await kept(first)).toEqual([]);
    expect(await kept(second)).toEqual(['01']);
  });
});

describe('a record that names files that are not prepared sound', () => {
  /** A Course whose own files the record wrongly names, over a limit of nothing. */
  async function seedRecordWithOwnFiles(h: Harness): Promise<{ first: string; second: string }> {
    // The only real sidecar: older than the Course opened next.
    const first = await openCourse(h, 'first', 1);
    await finishAll(h);
    h.clock.advance(60_000);
    const second = await h.folder('second', {
      ...lessons(1),
      '01 Extra.mp3': 'a sound file the learner keeps beside the Lessons',
      '.followalong/sound/notes.txt': 'notes of the learner',
    });
    // A damaged, hand-edited or buggy record: the oldest "opened" files are the learner's own.
    const record = h.storage.global.get('audioCache') as { version: number; files: unknown[] };
    await h.storage.global.set('audioCache', {
      version: record.version,
      files: [
        ...record.files,
        ...[
          join(second, '01 Lesson.mp4'),
          join(second, '01 Extra.mp3'),
          join(second, '.followalong', 'sound', 'notes.txt'),
        ].map((path) => ({ path, openedMs: 0 })),
      ],
    });
    await h.core.openCourse(second);
    h.player.ready(false);
    await h.settle();
    return { first, second };
  }

  const ownFiles = ['.followalong/sound/notes.txt', '01 Extra.mp3', '01 Lesson.mp4'];

  it('never deletes them when the cache is pruned, and says it left them out', async () => {
    const h = await createHarness();
    h.config.set('audioCacheLimit', 0);
    const { first, second } = await seedRecordWithOwnFiles(h);
    await finishAll(h);

    expect(await h.listFiles(second)).toEqual(expect.arrayContaining(ownFiles) as string[]);
    expect(await kept(first)).toEqual([]);
    expect(await kept(second)).toEqual(['01']);
    const lines = h.logger.entries.filter((entry) =>
      entry.message.includes('not a prepared sound file'),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn' });
  });

  it('never deletes them when the cache is cleared', async () => {
    const h = await createHarness();
    const { first, second } = await seedRecordWithOwnFiles(h);
    await finishAll(h);

    await h.core.clearAudioCache();

    expect(await h.listFiles(second)).toEqual(expect.arrayContaining(ownFiles) as string[]);
    expect(await kept(first)).toEqual([]);
    expect(await kept(second)).toEqual(['01']);
    expect(h.ui.messages.at(-1)).toEqual({
      severity: 'info',
      text: 'FollowAlong deleted 1 prepared sound file (13 bytes). The loaded Lesson’s sound stays.',
    });
  });
});

describe('Clear audio cache', () => {
  it('deletes every prepared sound file in both stores, and nothing else', async () => {
    const h = await createHarness();
    const first = await h.folder('first', {
      ...lessons(3),
      '01 Lesson.pdf': 'notes',
      '.followalong/sound/README.txt': 'not sound',
    });
    await h.core.openCourse(first);
    h.player.ready(false);
    await finishAll(h);
    // Another Course, read-only, keeps its sound in the extension's storage.
    const second = await h.folder('second', lessons(2));
    makeReadOnly(second);
    await h.core.openCourse(second);
    h.player.ready(false);
    await finishAll(h);
    expect(await kept(first)).toEqual(['01', '02', '03']);
    expect(await keptInStorage(h)).toEqual(['01', '02']);
    const others = async (folder: string): Promise<string[]> =>
      (await h.listFiles(folder)).filter((file) => !file.endsWith('.mp3'));
    const before = { first: await others(first), second: await others(second) };
    const storage = (await h.listFiles(h.storage.folder)).filter((file) => !file.endsWith('.mp3'));

    await h.core.clearAudioCache();

    expect(await kept(first)).toEqual([]);
    // The Lesson that is loaded keeps its sound, which the player is reading.
    expect(await keptInStorage(h)).toEqual(['01']);
    expect(await others(first)).toEqual(before.first);
    expect(await others(second)).toEqual(before.second);
    expect((await h.listFiles(h.storage.folder)).filter((file) => !file.endsWith('.mp3'))).toEqual(
      storage,
    );
    expect(h.ui.messages.at(-1)).toEqual({
      severity: 'info',
      text: 'FollowAlong deleted 4 prepared sound files (52 bytes). The loaded Lesson’s sound stays.',
    });
  });

  it('counts only the files it deleted itself', async () => {
    const h = await createHarness();
    const first = await openCourse(h, 'first', 1);
    await finishAll(h);
    h.clock.advance(60_000);
    await openCourse(h, 'second', 1);
    await finishAll(h);
    const held = h.holdRemovals();

    const clearing = h.core.clearAudioCache();
    await held.reached;
    // Another window deletes the older Course's sound while this one is about to.
    await rm(join(first, '.followalong', 'sound', await soundOf(first, '01')));
    held.release();
    await clearing;

    expect(h.ui.messages.at(-1)).toEqual({
      severity: 'info',
      text: 'FollowAlong has no other prepared sound to delete. The loaded Lesson’s sound stays.',
    });
  });

  it('says so when there is no prepared sound at all', async () => {
    const h = await createHarness();

    await h.core.clearAudioCache();

    expect(h.ui.messages).toEqual([
      { severity: 'info', text: 'The audio cache is empty: there is no prepared sound to delete.' },
    ]);
  });
});
