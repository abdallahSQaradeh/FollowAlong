import { describe, expect, it } from 'vitest';

import { isFullPath } from '../../src/core/folder-identity.js';

/**
 * Which setting entries name one folder wherever VS Code runs (ADR 0022), under each OS's path
 * rules, on every OS: CI runs the Windows rules only on Windows otherwise.
 * The `\\?\` (verbatim) and `\\.\` (device) prefixes are not full paths on Windows: they would
 * spell `D:\Learning` a second way, past the drive-letter normalisation (ADR 0033).
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
  { path: '\\\\?\\d:\\Learning', win32: false, posix: false },
  { path: '\\\\?\\D:\\Learning', win32: false, posix: false },
  { path: '\\\\?\\UNC\\server\\share', win32: false, posix: false },
  { path: '//?/d:/Learning', win32: false, posix: true },
  { path: '\\\\.\\d:\\Learning', win32: false, posix: false },
  { path: '\\\\.\\PhysicalDrive0', win32: false, posix: false },
  { path: '//./pipe/x', win32: false, posix: true },
  { path: '\\\\?', win32: false, posix: false },
  { path: '\\\\.hidden\\share', win32: true, posix: false },
] as const;

describe('a Courses root is a full path', () => {
  it.each(cases)('$path: Windows $win32, POSIX $posix', ({ path, win32, posix }) => {
    expect({ win32: isFullPath(path, 'win32'), posix: isFullPath(path, 'posix') }).toEqual({
      win32,
      posix,
    });
  });
});
