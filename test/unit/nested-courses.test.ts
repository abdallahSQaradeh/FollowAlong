import { describe, expect, it } from 'vitest';

import { folderLabel, scanCourses } from '../../src/core/course-scanner.js';
import type { Logger } from '../../src/core/logger.js';
import type { FileSystem } from '../../src/core/ports.js';

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
  it('is listed under the drive’s name, not an empty label', async () => {
    const driveRoot = process.platform === 'win32' ? 'C:\\' : '/';
    const fileSystem: FileSystem = {
      readDirectory: (path) =>
        Promise.resolve(path === driveRoot ? [{ name: '01 Intro.mp4', kind: 'file' }] : []),
      readText: () => Promise.reject(new Error('not read')),
      writeText: () => Promise.reject(new Error('not written')),
      makeDirectory: () => Promise.reject(new Error('not made')),
    };
    const logger: Logger = { log: () => undefined };

    const scan = await scanCourses({ fileSystem, logger }, [driveRoot]);

    expect(scan.courses.map((course) => course.name)).toEqual([
      process.platform === 'win32' ? 'C:' : '/',
    ]);
  });
});
