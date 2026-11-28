/**
 * The length job (#136, ADR 0109): when a Course opens, each Lesson's length is read from its file
 * in the background, kept in the Lesson length cache, and shown by the Lesson picker. Seam 1: a
 * real temp-dir Course, the fake converter for ffmpeg, observed through the picker, the log, the
 * learner's messages and the probes the converter is asked for.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

/** A Course of three Lessons in two Sections, nothing played yet. */
async function course(h: Harness, name = 'Course'): Promise<string> {
  return h.folder(name, {
    'Part/01 Intro.mp4': 'v',
    'Part/02 Series.mp4': 'v',
    'Other/03 Extra.mp4': 'v',
  });
}

/** The items as the learner reads them: label, then the text beside it. */
function items(h: Harness): string[] {
  return (h.ui.picker?.entries ?? []).flatMap((entry) =>
    entry.kind === 'item' ? [`${entry.label} | ${entry.description ?? ''}`] : [],
  );
}

/** The Lesson files the converter was asked the length of, by name. */
function probed(h: Harness): string[] {
  return h.converter.lengthProbes.map((probe) => probe.input.split(/[\\/]/).at(-1) ?? '');
}

describe('the length job', () => {
  it('shows the length read from the file for a Lesson never played', async () => {
    const h = await createHarness();
    const folder = await course(h);
    h.converter.lengths.set(join(folder, 'Part', '01 Intro.mp4'), 600);
    h.converter.lengths.set(join(folder, 'Part', '02 Series.mp4'), 2405);

    await h.core.openCourse(folder);
    await h.settle();
    void h.core.goToLesson();

    expect(items(h)).toEqual([
      '○ Extra | Other',
      '○ Intro | Part  ·  10:00',
      '○ Series | Part  ·  40:05',
    ]);
    expect(probed(h)).toEqual(['03 Extra.mp4', '01 Intro.mp4', '02 Series.mp4']);
  });

  it('never makes the picker wait: with ffmpeg stalled, it shows at once with no lengths', async () => {
    const h = await createHarness();
    const folder = await course(h);
    h.converter.stallLengths = true;
    await h.core.openCourse(folder);
    await h.settle();

    void h.core.goToLesson();

    expect(items(h)).toEqual(['○ Extra | Other', '○ Intro | Part', '○ Series | Part']);
    expect(probed(h)).toEqual(['03 Extra.mp4']);
  });

  it('fills in a length in the open picker as its probe lands, without closing it', async () => {
    const h = await createHarness();
    const folder = await course(h);
    h.converter.lengths.set(join(folder, 'Other', '03 Extra.mp4'), 125);
    h.converter.holdLengths = true;
    await h.core.openCourse(folder);
    await h.settle();
    void h.core.goToLesson();
    expect(items(h)).toEqual(['○ Extra | Other', '○ Intro | Part', '○ Series | Part']);

    const updated = h.ui.nextUpdate();
    await h.converter.releaseLength();
    await updated;

    // The same quick pick is updated, so what the learner typed in it stays (LivePicker.update).
    expect(h.ui.pickers).toHaveLength(1);
    expect(items(h)).toEqual(['○ Extra | Other  ·  02:05', '○ Intro | Part', '○ Series | Part']);
  });

  it('fills in the Lesson tree as a probe lands, for a Lesson in progress with no saved length', async () => {
    const h = await createHarness();
    const folder = await h.folder('Course', {
      'Part/01 Intro.mp4': 'v',
      'Other/02 Extra.mp4': 'v',
      '.followalong/progress.json': JSON.stringify({
        version: 1,
        data: {
          lessons: {
            'Part/01 Intro.mp4': {
              position: 750,
              duration: 0,
              savedAt: 1000,
              status: 'inProgress',
            },
          },
        },
      }),
    });
    h.converter.lengths.set(join(folder, 'Part', '01 Intro.mp4'), 2405);
    h.converter.holdLengths = true;
    await h.core.openCourse(folder);
    await h.settle();

    // Extra, then Intro, in Course order.
    await h.converter.releaseLength();
    await h.settle();
    await h.converter.releaseLength();
    await h.settle();

    const part = h.ui.lessonTree?.nodes.find((node) => node.label === 'Part');
    expect(part?.kind === 'section' ? part.children : []).toEqual([
      expect.objectContaining({ label: 'Intro', description: '12:30 / 40:05' }),
    ]);
  });

  it('shows no length for a Lesson ffmpeg cannot read, and only logs it', async () => {
    const h = await createHarness();
    const folder = await course(h);
    h.converter.unreadableLengths.set(join(folder, 'Part', '01 Intro.mp4'), 'Invalid data found');
    h.converter.lengths.set(join(folder, 'Part', '02 Series.mp4'), 2405);

    await h.core.openCourse(folder);
    await h.settle();
    void h.core.goToLesson();

    expect(items(h)).toEqual(['○ Extra | Other', '○ Intro | Part', '○ Series | Part  ·  40:05']);
    const warnings = h.logger.entries.filter((entry) => entry.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('01 Intro.mp4');
    expect(warnings[0]?.message).toContain('Invalid data found');
    expect(h.ui.messages).toEqual([]);
  });

  it('gives up on the Course, logging once, when ffmpeg does not answer within 30 seconds', async () => {
    const h = await createHarness();
    const folder = await course(h);
    h.converter.stallLengths = true;
    await h.core.openCourse(folder);
    await h.settle();

    h.clock.advance(30_000);
    await h.settle();

    expect(probed(h)).toEqual(['03 Extra.mp4']);
    expect(h.converter.lengthProbes[0]?.signal.aborted).toBe(true);
    const warnings = h.logger.entries.filter((entry) => entry.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('30 seconds');
    expect(h.ui.messages).toEqual([]);
  });

  it('probes nothing again in a new window for files that have not changed, and probes a changed one', async () => {
    const h = await createHarness();
    const folder = await course(h);
    h.converter.lengths.set(join(folder, 'Part', '01 Intro.mp4'), 600);
    h.converter.lengths.set(join(folder, 'Part', '02 Series.mp4'), 2405);
    await h.core.openCourse(folder);
    await h.settle();
    await h.core.close();

    h.restart();
    h.converter.lengthProbes.length = 0;
    await h.core.openCourse(folder);
    await h.settle();
    void h.core.goToLesson();

    expect(probed(h)).toEqual([]);
    expect(items(h)).toEqual([
      '○ Extra | Other',
      '○ Intro | Part  ·  10:00',
      '○ Series | Part  ·  40:05',
    ]);

    h.ui.dismissPicker();
    await h.core.close();
    await h.folder('Course', { 'Part/02 Series.mp4': 'a longer video' });
    h.converter.lengths.set(join(folder, 'Part', '02 Series.mp4'), 3000);
    h.restart();
    await h.core.openCourse(folder);
    await h.settle();
    void h.core.goToLesson();

    expect(probed(h)).toEqual(['02 Series.mp4']);
    expect(items(h)).toContain('○ Series | Part  ·  50:00');
  });

  it('stops the probe under way when another Course opens', async () => {
    const h = await createHarness();
    const first = await course(h, 'First');
    const second = await course(h, 'Second');
    h.converter.stallLengths = true;
    await h.core.openCourse(first);
    await h.settle();

    await h.core.openCourse(second);
    await h.settle();

    expect(h.converter.lengthProbes.map((probe) => probe.signal.aborted)).toEqual([true, false]);
    expect(h.logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
  });

  it('shows the length the player measured over the one read from the file', async () => {
    const h = await createHarness();
    const folder = await h.folder('Course', {
      'Part/01 Intro.mp4': 'v',
      'Other/02 Extra.mp4': 'v',
      '.followalong/progress.json': JSON.stringify({
        version: 1,
        data: {
          lessons: {
            'Part/01 Intro.mp4': { position: 590, duration: 600, savedAt: 1000, status: 'done' },
          },
        },
      }),
    });
    h.converter.lengths.set(join(folder, 'Part', '01 Intro.mp4'), 700);

    await h.core.openCourse(folder);
    await h.settle();
    void h.core.goToLesson();

    expect(items(h)).toEqual(['○ Extra | Other', '✓ Intro | Part  ·  10:00']);
  });
});
