/**
 * Where the ffmpeg that comes with FollowAlong is (ADR 0070). The .vsix is built for Windows x64
 * only, and `scripts/package.mjs` puts the ffmpeg at `bin/ffmpeg.exe` in it. On any other machine
 * (a Linux or macOS developer running the extension from source, say) there is none, and the
 * core falls back to `followalong.ffmpegPath` or ffmpeg on PATH.
 */
import { join } from 'node:path';

export function bundledFfmpegPath(
  extensionPath: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  return platform === 'win32' && arch === 'x64'
    ? join(extensionPath, 'bin', 'ffmpeg.exe')
    : undefined;
}
