import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { folderLabel, scanCourses } from '../../src/core/course-scanner.js';
import type { Logger } from '../../src/core/logger.js';
import type { FileSystem } from '../../src/core/ports.js';
import type { QuickPickModel } from '../../src/core/quick-pick.js';
import { createHarness, type Harness } from './harness.js';

/** The Course picker as the learner reads it: each Course as `label` or `label — description`. */
function courses(picker: QuickPickModel<unknown> | undefined): string[] {
  return (picker?.entries ?? []).flatMap((entry) =>
    entry.kind === 'item' && entry.label !== 'Add Courses root…' && entry.label !== 'Browse…'
      ? [entry.description === undefined ? entry.label : `${entry.label} — ${entry.description}`]
      : [],
  );
}

/** Opens the Course picker over `roots` and returns what it lists. */
async function listed(h: Harness, ...roots: string[]): Promise<string[]> {
  h.config.set('coursesRoots', roots);
  void h.core.pickCourse();
  await h.ui.pickerShown();
  return courses(h.ui.picker);
}

/**
 * What the Course picker names a Course whose folder is the Courses root itself, under each OS's
 * path rules, on every OS (`basename('D:\\')` is empty, which left the entry without a label).
 */
const labels = [
  { folder: 'D:\\', flavour: 'win32', label: 'D:' },
  { folder: 'D:\\Learning', flavour: 'win32', label: 'Learning' },
  { folder: '\\\\server\\share', flavour: 'win32', label: 'share' },
  { folder: '/', flavour: 'posix', label: '/' },
  { folder: '/learning', flavour: 'posix', label: 'learning' },
] as const;

describe('the label of a Course folder', () => {
  it.each(labels)('$folder on $flavour is “$label”', ({ folder, flavour, label }) => {
    expect(folderLabel(folder, flavour)).toBe(label);
  });
});

describe('a Course at the root of a drive', () => {
  // A drive root cannot be made in a temp dir, so this one test gives the scan a File system port
  // that lists it: the port is the seam, and the Course picker only shows `name`.
  it('is named after the drive, not an empty label', async () => {
    const driveRoot = process.platform === 'win32' ? 'C:\\' : '/';
    const fileSystem: FileSystem = {
      readDirectory: (path) =>
        Promise.resolve(path === driveRoot ? [{ name: '01 Intro.mp4', kind: 'file' }] : []),
      stat: () => Promise.reject(new Error('not stated')),
      startingFolders: () => Promise.resolve([]),
      readText: () => Promise.reject(new Error('not read')),
      exists: () => Promise.resolve(true),
      writeText: () => Promise.reject(new Error('not written')),
      lock: () => Promise.reject(new Error('not locked')),
      makeDirectory: () => Promise.reject(new Error('not made')),
    };
    const logger: Logger = { log: () => undefined };

    const scan = await scanCourses({ fileSystem, logger }, [driveRoot]);

    expect(scan.courses.map((course) => course.name)).toEqual([
      process.platform === 'win32' ? 'C:' : '/',
    ]);
  });
});

describe('Courses under category and wrapper folders', () => {
  it('names a Course after its outermost single-child wrapper', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'JavaScript The Advanced Concepts/udemy-ajconfeb/01 Intro.mp4': 'v',
      'JavaScript The Advanced Concepts/udemy-ajconfeb/Section 2/02 Scope.mp4': 'v',
    });

    expect(await listed(h, learning)).toEqual(['JavaScript The Advanced Concepts']);
  });

  it('opens the folder that holds the Lessons, whatever the Course is called', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'JavaScript The Advanced Concepts/udemy-ajconfeb/01 Intro.mp4': 'v',
    });
    h.config.set('coursesRoots', [learning]);

    const picking = h.core.pickCourse();
    await h.ui.pickerShown();
    h.ui.choose('JavaScript The Advanced Concepts');
    await picking;
    h.player.ready();

    expect(h.player.sent).toMatchObject([
      {
        type: 'load',
        lessonId: '01 Intro.mp4',
        videoUri: h.player.resourceUri(
          [learning, 'JavaScript The Advanced Concepts', 'udemy-ajconfeb', '01 Intro.mp4'].join(
            process.platform === 'win32' ? '\\' : '/',
          ),
        ),
      },
    ]);
  });

  it('takes the outermost of several wrappers, and files it under its categories', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/Frontend/React - The Complete Guide/part 1/release-2024/01 Hello.mp4': 'v',
      'Web/Frontend/Vue Basics/01 Hello.mp4': 'v',
      'Web/Backend/Node Basics/01 Welcome.mp4': 'v',
      'Web/Backend/Express Basics/01 Welcome.mp4': 'v',
    });

    expect(await listed(h, learning)).toEqual([
      'Express Basics — Web / Backend',
      'Node Basics — Web / Backend',
      'React - The Complete Guide — Web / Frontend',
      'Vue Basics — Web / Frontend',
    ]);
  });

  it('does not take a folder of several Courses for a wrapper', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Python/Intro Course/01 Hello.mp4': 'v',
      'Python/Advanced Course/01 Hello.mp4': 'v',
    });

    expect(await listed(h, learning)).toEqual([
      'Advanced Course — Python',
      'Intro Course — Python',
    ]);
  });

  it('keeps a wrapper a wrapper when a sibling folder or file holds no video', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Docker Mastery/docker-mastery-2024/01 Intro.mp4': 'v',
      'Docker Mastery/docker-mastery-2024/code.zip': 'zip',
      'Docker Mastery/extras/cheatsheet.pdf': 'pdf',
      'Docker Mastery/readme.txt': 'text',
    });

    expect(await listed(h, learning)).toEqual(['Docker Mastery']);
  });

  it('never takes the Courses root itself for a wrapper', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', { 'Only Course/01 Intro.mp4': 'v' });

    expect(await listed(h, learning)).toEqual(['Only Course']);
  });

  it('lists a Course with no category without a description', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Top Course/01 Intro.mp4': 'v',
      'Web/React Basics/01 Hello.mp4': 'v',
      'Web/Vue Basics/01 Hello.mp4': 'v',
    });

    expect(await listed(h, learning)).toEqual([
      'React Basics — Web',
      'Top Course',
      'Vue Basics — Web',
    ]);
  });

  it('turns on matching the category path when the learner types', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/Frontend/React Basics/01 Hello.mp4': 'v',
      'Web/Frontend/Vue Basics/01 Hello.mp4': 'v',
    });

    await listed(h, learning);

    // VS Code does the filtering: it matches the description only when the model asks it to.
    expect(h.ui.picker?.matchOnDescription).toBe(true);
  });

  it('lists a known Course, one with .followalong, when its videos are only in subfolders', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Known Course/.followalong/progress.json': '{}',
      'Known Course/Section 1/01 Intro.mp4': 'v',
      'Known Course/Section 2/02 Next.mp4': 'v',
      'Unknown Course/Section 1/01 Intro.mp4': 'v',
      'Unknown Course/Section 2/02 Next.mp4': 'v',
    });

    // Without .followalong the scan cannot know that the folder above a Section is a Course.
    expect(await listed(h, learning)).toEqual([
      'Known Course',
      'Section 1 — Unknown Course',
      'Section 2 — Unknown Course',
    ]);
  });

  it('does not list a folder with .followalong when no video is below it', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Emptied Course/.followalong/progress.json': '{}',
      'Emptied Course/notes.txt': 'text',
      'Real Course/01 Intro.mp4': 'v',
    });

    expect(await listed(h, learning)).toEqual(['Real Course']);
  });

  it('leaves out folders that hold only a zip, wherever they are', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Zipped Course/zipped-course.zip': 'zip',
      'Category/Also Zipped/01.zip': 'zip',
      'Category/Real Course/01 Intro.mp4': 'v',
      'Category/Real Course/code.zip': 'zip',
      'Category/Other Course/01 Intro.mp4': 'v',
      'Known Zip/.followalong/progress.json': '{}',
      'Known Zip/code.zip': 'zip',
    });

    expect(await listed(h, learning)).toEqual([
      'Other Course — Category',
      'Real Course — Category',
    ]);
  });

  it('lists a Course found under two roots once, as the first root files it', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React Basics/01 Hello.webm': 'v',
      'Web/Vue Basics/01 Hello.webm': 'v',
    });

    expect(await listed(h, learning, join(learning, 'Web'))).toEqual([
      'React Basics — Web',
      'Vue Basics — Web',
    ]);
  });

  it('files a Course by the root named first, whichever order the roots are in', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React Basics/01 Hello.webm': 'v',
      'Web/Vue Basics/01 Hello.webm': 'v',
    });

    // Under the Web root the same Courses have no category.
    expect(await listed(h, join(learning, 'Web'), learning)).toEqual([
      'React Basics',
      'Vue Basics',
    ]);
  });

  it('lists a Course once when an overlapping root names its folder in other letter case', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Web/React Basics/01 Hello.webm': 'v',
      'Web/Vue Basics/01 Hello.webm': 'v',
    });
    // On Windows `learning` is the same folder as `Learning`, so the second root lies inside the
    // first. On Linux it is another folder, which is not there. On a case-insensitive macOS volume
    // it is the same folder, but keys keep letter case there, so this test would fail; CI runs
    // Ubuntu and Windows only.
    const otherCase = join(dirname(learning), 'learning', 'Web');

    expect(await listed(h, learning, otherCase)).toEqual([
      'React Basics — Web',
      'Vue Basics — Web',
    ]);
  });

  it('does not take a folder for a wrapper when a subfolder beside the Course cannot be read', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      'Docker Mastery/docker-mastery-2024/01 Intro.mp4': 'v',
      'Docker Mastery/Locked Folder/02 Other.mp4': 'v',
      'Other/01 Intro.mp4': 'v',
    });
    h.makeUnreadable(join(learning, 'Docker Mastery', 'Locked Folder'));

    // The unreadable folder may hold a second Course, so “Docker Mastery” may be a category.
    expect(await listed(h, learning)).toEqual(['docker-mastery-2024 — Docker Mastery', 'Other']);
  });

  it('lists a library laid out as the real downloads are', async () => {
    const h = await createHarness();
    const learning = await h.folder('Learning', {
      // A wrapper named by the instructor around the folder the platform's download made.
      'JavaScript The Advanced Concepts/udemy-ajconfeb/01 Intro.mp4': 'v',
      'JavaScript The Advanced Concepts/udemy-ajconfeb/02 Scope.mp4': 'v',
      'JavaScript The Advanced Concepts/udemy-ajconfeb/Resources/slides.pdf': 'pdf',
      'JavaScript The Advanced Concepts/udemy-ajconfeb/code.zip': 'zip',
      // Categories, two levels deep, and a wrapper below them.
      'Web/Frontend/React - The Complete Guide/React - The Complete Guide/01 Hello.mp4': 'v',
      'Web/Frontend/Vue Basics/01 Hello.mp4': 'v',
      'Web/Frontend/Vue Basics/Section 2/02 Next.mp4': 'v',
      'Web/Backend/Node Basics/01 Welcome.mp4': 'v',
      'Web/Backend/Deno Basics/01 Welcome.mp4': 'v',
      // Only a zip: not a Course.
      'Web/Backend/Express Basics/express-basics.zip': 'zip',
      // Known: a Course with Lessons only in Sections, which FollowAlong has been used on.
      'Algorithms/.followalong/progress.json': '{}',
      'Algorithms/Part 1/01 Sorting.mp4': 'v',
      'Algorithms/Part 2/01 Graphs.mp4': 'v',
      // Downloads still zipped, and a folder of notes.
      'Zipped/Python Bootcamp.zip': 'zip',
      'Notes/cheatsheet.pdf': 'pdf',
    });
    const more = await h.folder('More', { 'CSS Grid/lesson10.mp4': 'v' });

    expect(await listed(h, learning, more)).toEqual([
      'Algorithms',
      'CSS Grid',
      'Deno Basics — Web / Backend',
      'JavaScript The Advanced Concepts',
      'Node Basics — Web / Backend',
      'React - The Complete Guide — Web / Frontend',
      'Vue Basics — Web / Frontend',
    ]);
  });
});
