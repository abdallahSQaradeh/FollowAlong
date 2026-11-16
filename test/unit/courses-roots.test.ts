import { describe, expect, it } from 'vitest';

import { isFullPath } from '../../src/core/courses-roots.js';

/**
 * Which setting entries name one folder wherever VS Code runs (ADR 0022), under each OS's path
 * rules, on every OS: CI runs the Windows rules only on Windows otherwise.
 * `\\?\d:\x` is left out: it is accepted today without upper-casing its drive letter, which #34
 * owns.
 */
const cases = [
  { path: 'D:', win32: false, posix: false },
  { path: 'D:foo', win32: false, posix: false },
  { path: 'D:\\x', win32: true, posix: false },
  { path: '\\x', win32: false, posix: false },
  { path: '/x', win32: false, posix: true },
  { path: '\\\\server', win32: false, posix: false },
  { path: '\\\\server\\share', win32: true, posix: false },
  { path: '//server/share', win32: true, posix: true },
] as const;

describe('a Courses root is a full path', () => {
  it.each(cases)('$path: Windows $win32, POSIX $posix', ({ path, win32, posix }) => {
    expect({ win32: isFullPath(path, 'win32'), posix: isFullPath(path, 'posix') }).toEqual({
      win32,
      posix,
    });
  });
});
