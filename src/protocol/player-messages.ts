/**
 * The typed message protocol between the extension and the player webview (spec #12, Player →
 * Protocol; ADR 0003). The extension is the source of truth for which Lesson is loaded, the
 * player for the playhead. Both sides validate what they receive with the parse functions below,
 * because a message crosses a process boundary as plain JSON.
 */

/** A Lesson's video container. */
export type Container = 'mp4' | 'webm';

/** Extension → player. */
export type PlayerCommand =
  | {
      readonly type: 'load';
      /** The Lesson's path relative to its Course, with `/` separators. */
      readonly lessonId: string;
      /** A URI the webview may fetch (`asWebviewUri` in VS Code). */
      readonly videoUri: string;
      readonly container: Container;
      /** Seconds from the start of the Lesson. */
      readonly startAt: number;
      readonly autoplay: boolean;
    }
  | { readonly type: 'play' }
  | { readonly type: 'pause' };

/** Player → extension. Events about a Lesson carry its `lessonId`, so late events are recognisable. */
export type PlayerEvent =
  | { readonly type: 'ready'; readonly aacSupported: boolean }
  | {
      readonly type: 'timeUpdate';
      readonly lessonId: string;
      readonly position: number;
      readonly duration: number;
    }
  | { readonly type: 'played'; readonly lessonId: string }
  | { readonly type: 'paused'; readonly lessonId: string; readonly byUser: boolean }
  /**
   * A seek finished at `position` (seconds). Not posted for the seek that applies a `load`'s
   * `startAt`: that one is the extension's own, not a move of the playhead by the learner.
   */
  | { readonly type: 'seeked'; readonly lessonId: string; readonly position: number }
  | { readonly type: 'ended'; readonly lessonId: string }
  | { readonly type: 'error'; readonly lessonId: string; readonly message: string };

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Returns the command, or `undefined` when `raw` is not a well-formed player command. */
export function parsePlayerCommand(raw: unknown): PlayerCommand | undefined {
  if (!isFields(raw)) {
    return undefined;
  }
  switch (raw.type) {
    case 'load': {
      const { lessonId, videoUri, container, startAt, autoplay } = raw;
      if (
        isText(lessonId) &&
        isText(videoUri) &&
        (container === 'mp4' || container === 'webm') &&
        isSeconds(startAt) &&
        typeof autoplay === 'boolean'
      ) {
        return { type: 'load', lessonId, videoUri, container, startAt, autoplay };
      }
      return undefined;
    }
    case 'play':
    case 'pause':
      return { type: raw.type };
    default:
      return undefined;
  }
}

/** Returns the event, or `undefined` when `raw` is not a well-formed player event. */
export function parsePlayerEvent(raw: unknown): PlayerEvent | undefined {
  if (!isFields(raw)) {
    return undefined;
  }
  const { type, lessonId } = raw;
  if (type === 'ready') {
    return typeof raw.aacSupported === 'boolean'
      ? { type, aacSupported: raw.aacSupported }
      : undefined;
  }
  if (!isText(lessonId)) {
    return undefined;
  }
  switch (type) {
    case 'timeUpdate': {
      const { position, duration } = raw;
      // A WebM fed through MediaSource reports an unknown (NaN) or infinite duration until the
      // whole file is appended; the player sends 0 then, so both fields are always finite.
      return isSeconds(position) && isSeconds(duration)
        ? { type, lessonId, position, duration }
        : undefined;
    }
    case 'played':
    case 'ended':
      return { type, lessonId };
    case 'seeked':
      return isSeconds(raw.position) ? { type, lessonId, position: raw.position } : undefined;
    case 'paused':
      return typeof raw.byUser === 'boolean' ? { type, lessonId, byUser: raw.byUser } : undefined;
    case 'error':
      return isText(raw.message) ? { type, lessonId, message: raw.message } : undefined;
    default:
      return undefined;
  }
}
