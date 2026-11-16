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
  | { readonly type: 'seekBy'; readonly seconds: number }
  /**
   * The seconds the player steps back when the learner resumes a paused Lesson with a click on the
   * picture (Rewind, ADR 0016). 0 means none. Holds until the next one; a `load` does not reset it.
   */
  | { readonly type: 'setResumeRewind'; readonly seconds: number }
  /** Sets the playback rate (1 is normal speed); it stays for the Lessons that follow. */
  | { readonly type: 'setRate'; readonly rate: number }
  /**
   * Shows the "Next: <title>" overlay over the picture of the Lesson that has ended (ADR 0019). The
   * player hides it again when a Lesson loads, plays or seeks.
   */
  | { readonly type: 'showNext'; readonly title: string };

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
  /** The playback rate is now `rate`, whoever changed it (a `setRate` or the video's own menu). */
  | { readonly type: 'rateChanged'; readonly lessonId: string; readonly rate: number }
  | { readonly type: 'error'; readonly lessonId: string; readonly message: string }
  /** The learner clicked the "Next: <title>" overlay shown for this Lesson's end. */
  | { readonly type: 'nextClicked'; readonly lessonId: string };

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

/** A playback rate a media element accepts in practice: finite and above 0. */
function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
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
    case 'setResumeRewind':
      return isSeconds(raw.seconds) ? { type: 'setResumeRewind', seconds: raw.seconds } : undefined;
    case 'setRate':
      return isRate(raw.rate) ? { type: 'setRate', rate: raw.rate } : undefined;
    case 'showNext':
      return isText(raw.title) ? { type: 'showNext', title: raw.title } : undefined;
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
    case 'seeked':
    case 'nextClicked':
      return { type, lessonId };
    case 'rateChanged':
      return isRate(raw.rate) ? { type, lessonId, rate: raw.rate } : undefined;
    case 'paused':
      return typeof raw.byUser === 'boolean' ? { type, lessonId, byUser: raw.byUser } : undefined;
    case 'error':
      return isText(raw.message) ? { type, lessonId, message: raw.message } : undefined;
    default:
      return undefined;
  }
}
