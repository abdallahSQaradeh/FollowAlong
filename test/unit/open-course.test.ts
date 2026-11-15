import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness } from './harness.js';

describe('opening a Course', () => {
  it('plays its first WebM Lesson in the player beside the code, with sound', async () => {
    const h = await createHarness();
    const course = await h.folder('JavaScript The Advanced Concepts', {
      'Section 1/01 Welcome.webm': 'video',
      'Section 1/02 Setup.webm': 'video',
      'notes.pdf': 'pdf',
    });

    await h.core.openCourse(course);
    h.player.ready();

    expect(h.player.shown).toEqual([
      { title: '01 Welcome', resourceRoots: [course, h.storage.folder] },
    ]);
    expect(h.player.sent).toEqual([
      {
        type: 'load',
        lessonId: 'Section 1/01 Welcome.webm',
        videoUri: h.player.resourceUri(join(course, 'Section 1', '01 Welcome.webm')),
        container: 'webm',
        startAt: 0,
        autoplay: true,
      },
    ]);
  });
});
