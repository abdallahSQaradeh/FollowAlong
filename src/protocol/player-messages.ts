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
  | { readonly type: 'pause' }
  /** Moves the playhead by `seconds` (negative: back), stopping at the start or the end. */
  | { readonly type: 'seekBy'; readonly seconds: number };

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
  | { readonly type: 'ended'; readonly lessonId: string }
  /** The playhead has arrived at the place a seek asked for (also after a seek bar drag). */
  | { readonly type: 'seeked'; readonly lessonId: string }
  | { readonly type: 'error'; readonly lessonId: string; readonly message: string }
  /**
   * The learner finished an interaction with the player page (a click, a key, a native control,
   * the release of a seek-bar drag), so the extension hands keyboard focus back to the Practice
   * area (Focus return, ADR 0009). Not about a Lesson: it carries no `lessonId`.
   */
  | { readonly type: 'userInteracted' };

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
    case 'seekBy':
      return typeof raw.seconds === 'number' && Number.isFinite(raw.seconds)
        ? { type: 'seekBy', seconds: raw.seconds }
        : undefined;
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
  if (type === 'userInteracted') {
    return { type };
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
    case 'seeked':
      return { type, lessonId };
    case 'paused':
      return typeof raw.byUser === 'boolean' ? { type, lessonId, byUser: raw.byUser } : undefined;
    case 'error':
      return isText(raw.message) ? { type, lessonId, message: raw.message } : undefined;
    default:
      return undefined;
  }
}
