/**
 * The Converter port until FollowAlong ships ffmpeg. WebM Lessons need no conversion, so nothing
 * calls it yet; the MP4 sound tickets replace this with a real ffmpeg adapter.
 */
import type { Converter } from '../../core/ports.js';

export function createUnavailableConverter(): Converter {
  return {
    extractSound: (request) =>
      Promise.reject(
        new Error(`Cannot prepare sound for ${request.input}: this FollowAlong has no ffmpeg yet.`),
      ),
  };
}
