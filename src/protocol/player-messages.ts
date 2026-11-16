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
      /**
       * Which load this is: the extension counts its loads, and the player echoes the number on
       * every event about the Lesson, so a late event from an earlier load of the same page (the
       * same `lessonId` in another Course, ADR 0022) is recognisable. Optional: without it the
       * events carry none.
       */
      readonly loadId?: number;
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
  | { readonly type: 'showNext'; readonly title: string }
  /**
   * The loaded MP4 Lesson's sound, converted to MP3 because the player cannot decode AAC (ADR 0034).
   * The player plays it in a hidden `<audio>` that follows the muted video. Sent after the `load`
   * it belongs to, and only while that `load` is the current one.
   */
  | { readonly type: 'soundReady'; readonly audioUri: string }
  /**
   * The loaded MP4 Lesson's sound could not be prepared: the player stops waiting for it and plays
   * the video muted (ADR 0034). Ticket #42 puts an overlay and a "Play without sound" button here.
   */
  | { readonly type: 'soundFailed'; readonly message: string };

/**
 * What every event about a Lesson carries, so late events are recognisable: the Lesson's id, and
 * the `loadId` of the `load` that brought it, when that `load` had one.
 */
export interface AboutLesson {
  readonly lessonId: string;
  readonly loadId?: number;
}

/** Player → extension. */
export type PlayerEvent =
  | { readonly type: 'ready'; readonly aacSupported: boolean }
  | (AboutLesson & {
      readonly type: 'timeUpdate';
      readonly position: number;
      readonly duration: number;
    })
  | (AboutLesson & { readonly type: 'played' })
  | (AboutLesson & { readonly type: 'paused'; readonly byUser: boolean })
  | (AboutLesson & { readonly type: 'ended' })
  /** The playhead has arrived at the place a seek asked for (also after a seek bar drag). */
  | (AboutLesson & { readonly type: 'seeked' })
  /** The playback rate is now `rate`, whoever changed it (today only `setRate`: ADR 0009). */
  | (AboutLesson & { readonly type: 'rateChanged'; readonly rate: number })
  | (AboutLesson & { readonly type: 'error'; readonly message: string })
  /** The learner clicked the "Next: <title>" overlay shown for this Lesson's end. */
  | (AboutLesson & { readonly type: 'nextClicked' })
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

/** A load number: a whole number from 0 up. */
function isLoadId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
      const { lessonId, videoUri, container, startAt, autoplay, loadId } = raw;
      if (
        isText(lessonId) &&
        isText(videoUri) &&
        (container === 'mp4' || container === 'webm') &&
        isSeconds(startAt) &&
        typeof autoplay === 'boolean' &&
        (loadId === undefined || isLoadId(loadId))
      ) {
        return {
          type: 'load',
          lessonId,
          videoUri,
          container,
          startAt,
          autoplay,
          ...(loadId === undefined ? {} : { loadId }),
        };
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
    case 'soundReady':
      return isText(raw.audioUri) ? { type: 'soundReady', audioUri: raw.audioUri } : undefined;
    case 'soundFailed':
      return isText(raw.message) ? { type: 'soundFailed', message: raw.message } : undefined;
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
  const { loadId } = raw;
  if (!isText(lessonId) || !(loadId === undefined || isLoadId(loadId))) {
    return undefined;
  }
  const about: AboutLesson = { lessonId, ...(loadId === undefined ? {} : { loadId }) };
  switch (type) {
    case 'timeUpdate': {
      const { position, duration } = raw;
      // A WebM fed through MediaSource reports an unknown (NaN) or infinite duration until the
      // whole file is appended; the player sends 0 then, so both fields are always finite.
      return isSeconds(position) && isSeconds(duration)
        ? { type, ...about, position, duration }
        : undefined;
    }
    case 'played':
    case 'ended':
    case 'seeked':
    case 'nextClicked':
      return { type, ...about };
    case 'rateChanged':
      return isRate(raw.rate) ? { type, ...about, rate: raw.rate } : undefined;
    case 'paused':
      return typeof raw.byUser === 'boolean' ? { type, ...about, byUser: raw.byUser } : undefined;
    case 'error':
      return isText(raw.message) ? { type, ...about, message: raw.message } : undefined;
    default:
      return undefined;
  }
}
