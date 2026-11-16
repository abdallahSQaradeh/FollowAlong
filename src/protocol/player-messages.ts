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
   * The player plays it in a hidden `<audio>` that follows the video. Sent after the `load`
   * it belongs to, and only while that `load` is the current one.
   */
  | { readonly type: 'soundReady'; readonly audioUri: string }
  /**
   * The loaded MP4 Lesson's sound could not be prepared: the player stops waiting for it and lets
   * the video play without sound (ADR 0034). Ticket #42 replaces that with an overlay and a "Play
   * without sound" button.
   */
  | { readonly type: 'soundFailed'; readonly message: string }
  /**
   * The loaded MP4 Lesson needs no sidecar: it has no sound, or its sound is one the page decodes
   * itself (ADR 0034). The player stops waiting and plays the video as it is.
   */
  | { readonly type: 'noSidecar' }
  /**
   * Changes the picture's zoom (ADR 0037). The player reports `zoomChanged` when the level changes:
   * a reset at 1× reports nothing.
   */
  | { readonly type: 'zoom'; readonly action: ZoomAction }
  /**
   * Asks the page what it shows and plays, for a move of the player to another spot (ADR 0049).
   * The page answers with one `snapshot`.
   */
  | { readonly type: 'takeSnapshot' }
  /**
   * The page takes over the zoom of the page it replaces in another spot (ADR 0049). Sent after
   * the `load` that brings the Lesson back; the playhead and play state travel in that `load`
   * (`startAt`, `autoplay`), the speed in a `setRate`.
   */
  | { readonly type: 'restore'; readonly zoom: ZoomView };

/**
 * What a `zoom` command does. `reset` shows the whole picture (the status bar item); #48 adds
 * `in`, `out` and `areaMode` for the keys.
 */
export type ZoomAction = 'reset';

/**
 * What every event about a Lesson carries, so late events are recognisable: the Lesson's id, and
 * the `loadId` of the `load` that brought it, when that `load` had one.
 */
export interface AboutLesson {
  readonly lessonId: string;
  readonly loadId?: number;
}

/**
 * What part of the whole picture the player shows (ADR 0037). Fractions, not pixels, so the same
 * area shows in a player of any size, and in another spot (ADR 0049).
 */
export interface ZoomView {
  /** 1 shows the whole picture; 2 shows half its width and half its height. */
  readonly level: number;
  /** The left edge of the shown area, as a fraction of the picture's width. */
  readonly left: number;
  /** The top edge of the shown area, as a fraction of the picture's height. */
  readonly top: number;
}

/** The view of the whole picture: what a page shows until the learner zooms. */
export const wholePicture: ZoomView = { level: 1, left: 0, top: 0 };

/** A copy of `view` with only its own fields, so nothing else a message carried passes on. */
function zoomViewOf(view: ZoomView): ZoomView {
  return { level: view.level, left: view.left, top: view.top };
}

/**
 * What a player page shows and plays (its answer to `takeSnapshot`), so a page in another spot
 * can carry on from it (ADR 0049).
 */
export interface PlayerSnapshot {
  /** The playback rate. */
  readonly rate: number;
  readonly zoom: ZoomView;
  /**
   * The Lesson the page holds: where its playhead is (where it will be, while the start position
   * is still being applied) and whether it plays. None when the page holds no Lesson, or only one
   * that failed.
   */
  readonly lesson?: AboutLesson & { readonly position: number; readonly playing: boolean };
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
  /**
   * The playhead has arrived at the place a seek asked for (also after a seek bar drag).
   * `startSeek` says whether it is the seek that applied the `load`'s `startAt` (true) or any
   * other seek, the learner's included (false). A player that omits it leaves the core to take
   * the first `seeked` after a `load` with a `startAt` for the start seek (ADR 0030).
   */
  | (AboutLesson & { readonly type: 'seeked'; readonly startSeek?: boolean })
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
  | { readonly type: 'userInteracted' }
  /**
   * The picture's zoom level changed (1 is the whole picture), whoever changed it. Zoom belongs to
   * the player page, not to a Lesson (ADR 0037): it carries no `lessonId`.
   */
  | { readonly type: 'zoomChanged'; readonly level: number }
  /** The answer to `takeSnapshot`. Not about a Lesson as such: the Lesson, if any, is inside. */
  | { readonly type: 'snapshot'; readonly snapshot: PlayerSnapshot };

/**
 * How a zoom level reads wherever it is shown (the player's toolbar, the status bar item): to one
 * decimal, without a trailing `.0`: `1×`, `1.3×`, `2.4×` (ADR 0037).
 */
export function zoomLabel(level: number): string {
  return `${String(shownZoomLevel(level))}×`;
}

/** A zoom level as it is shown: to one decimal. A level that shows as 1 is the whole picture. */
export function shownZoomLevel(level: number): number {
  return Number(level.toFixed(1));
}

/** The closest the player zooms in (from the prototype: further is only blur), ADR 0037. */
export const maxZoomLevel = 8;

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

/** A zoom level the player can show: from 1 (the whole picture) to {@link maxZoomLevel}. */
function isZoomLevel(value: unknown): value is number {
  return typeof value === 'number' && value >= 1 && value <= maxZoomLevel;
}

/** Whether `value` is a view the player can show; it crosses the protocol as plain data. */
export function isZoomView(value: unknown): value is ZoomView {
  if (!isFields(value)) {
    return false;
  }
  const { level, left, top } = value;
  return (
    typeof level === 'number' &&
    typeof left === 'number' &&
    typeof top === 'number' &&
    // 1, or a level that reads above 1×: the player never makes a view between them.
    (level === 1 || shownZoomLevel(level) > 1) &&
    level <= maxZoomLevel &&
    left >= 0 &&
    top >= 0 &&
    left <= 1 - 1 / level &&
    top <= 1 - 1 / level
  );
}

/** Returns the snapshot, or `undefined` when `raw` is not a well-formed one. */
function parseSnapshot(raw: unknown): PlayerSnapshot | undefined {
  if (!isFields(raw) || !isRate(raw.rate) || !isZoomView(raw.zoom)) {
    return undefined;
  }
  const { rate, zoom, lesson } = raw;
  if (lesson === undefined) {
    return { rate, zoom: zoomViewOf(zoom) };
  }
  if (!isFields(lesson)) {
    return undefined;
  }
  const { lessonId, loadId, position, playing } = lesson;
  if (
    !isText(lessonId) ||
    !(loadId === undefined || isLoadId(loadId)) ||
    !isSeconds(position) ||
    typeof playing !== 'boolean'
  ) {
    return undefined;
  }
  return {
    rate,
    zoom: zoomViewOf(zoom),
    lesson: { lessonId, ...(loadId === undefined ? {} : { loadId }), position, playing },
  };
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
    case 'noSidecar':
      return { type: 'noSidecar' };
    case 'zoom':
      return raw.action === 'reset' ? { type: 'zoom', action: raw.action } : undefined;
    case 'takeSnapshot':
      return { type: 'takeSnapshot' };
    case 'restore': {
      const { zoom } = raw;
      return isZoomView(zoom) ? { type: 'restore', zoom: zoomViewOf(zoom) } : undefined;
    }
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
  if (type === 'zoomChanged') {
    return isZoomLevel(raw.level) ? { type, level: raw.level } : undefined;
  }
  if (type === 'snapshot') {
    const snapshot = parseSnapshot(raw.snapshot);
    return snapshot === undefined ? undefined : { type, snapshot };
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
    case 'seeked':
      if (raw.startSeek === undefined) {
        return { type, ...about };
      }
      return typeof raw.startSeek === 'boolean'
        ? { type, ...about, startSeek: raw.startSeek }
        : undefined;
    case 'played':
    case 'ended':
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
