/**
 * The ports the FollowAlong core depends on (spec #12, Implementation Decisions → Architecture;
 * ADR 0002). The core never imports `vscode`: thin adapters implement these ports, and Seam 1
 * tests pass fakes for everything except the file system, which is real.
 */
import type { PlayerCommand, PlayerEvent } from '../protocol/player-messages.js';
import type { LessonTreeModel } from './lesson-tree.js';
import type { Logger } from './logger.js';
import type { QuickPickModel } from './quick-pick.js';
import type { StatusBarModel } from './status-bar.js';

export interface Disposable {
  dispose(): void;
}

// --- Player -----------------------------------------------------------------------------------

export interface PlayerShowOptions {
  /** The tab title: the Lesson's title. */
  readonly title: string;
  /** Absolute folders the player may read media from: the Course and the extension storage. */
  readonly resourceRoots: readonly string[];
}

/**
 * - `created`: a new player page is starting; it posts `ready` once it can take commands.
 * - `revealed`: the player that was already open, with the same resource roots, was brought to
 *   the front; it posts nothing new.
 */
export type PlayerShowResult = 'created' | 'revealed';

export interface PlayerPort {
  /** Shows the player beside the code without taking focus. */
  show(options: PlayerShowOptions): PlayerShowResult;
  /** The URI under which the player can fetch a file inside one of its resource roots. */
  resourceUri(absolutePath: string): string;
  send(command: PlayerCommand): void;
  onEvent(listener: (event: PlayerEvent) => void): Disposable;
  /** Calls `listener` when the learner closes the player: whatever it had loaded is gone. */
  onDidClose(listener: () => void): Disposable;
}

// --- File system --------------------------------------------------------------------------------

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
}

/** Why a file system call failed: `readOnly` is the read-only check FollowAlong falls back on. */
export type FileSystemErrorReason = 'notFound' | 'readOnly' | 'other';

export class FileSystemError extends Error {
  override readonly name = 'FileSystemError';

  constructor(
    readonly reason: FileSystemErrorReason,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }

  /** Whether `error` is a FileSystemError for this `reason`. */
  static is(error: unknown, reason: FileSystemErrorReason): error is FileSystemError {
    return error instanceof FileSystemError && error.reason === reason;
  }
}

/** Every method rejects with a {@link FileSystemError}. */
export interface FileSystem {
  readDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  readText(path: string): Promise<string>;
  /** Writes the whole file at once: readers see the old or the new content, never a mix. */
  writeText(path: string, content: string): Promise<void>;
  /** Creates the folder and its parents. `hidden` also sets the Windows hidden attribute. */
  makeDirectory(path: string, options: { readonly hidden: boolean }): Promise<void>;
}

// --- Storage ------------------------------------------------------------------------------------

export interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<void>;
}

export interface Storage {
  readonly global: KeyValueStore;
  readonly workspace: KeyValueStore;
  /** The extension's own storage folder (absolute), shared by every workspace. */
  readonly folder: string;
}

// --- Clock / scheduler --------------------------------------------------------------------------

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Runs `callback` once after `delayMs`, unless disposed first. */
  schedule(delayMs: number, callback: () => void): Disposable;
}

// --- Converter ----------------------------------------------------------------------------------

export interface ConversionRequest {
  /** The Lesson video to read the sound from. */
  readonly input: string;
  /** The sound file to write. */
  readonly output: string;
  readonly onProgress: (percent: number) => void;
  readonly signal: AbortSignal;
}

export interface Converter {
  /** Writes `output` and resolves, or rejects with the reason it could not. */
  extractSound(request: ConversionRequest): Promise<void>;
}

// --- Config -------------------------------------------------------------------------------------

export interface Config {
  /** The value of a `followalong.*` setting, by its name without the prefix. */
  get(name: string): unknown;
  /** Calls `listener` with a check for which settings changed. */
  onDidChange(listener: (affects: (name: string) => boolean) => void): Disposable;
}

// --- UI sink ------------------------------------------------------------------------------------

export interface UserMessage {
  readonly severity: 'info' | 'warning' | 'error';
  readonly text: string;
}

/** What a Resource opens as. Later tickets add targets (a URL, a preview, a PDF) beside `file`. */
export interface FileResourceTarget {
  readonly kind: 'file';
  readonly path: string;
}

export type ResourceTarget = FileResourceTarget;

export interface UiSink {
  showMessage(message: UserMessage): void;
  /**
   * Shows a quick pick and resolves with the intent of the item the learner picked, or
   * `undefined` when the learner closed it without picking.
   */
  pick<Intent>(model: QuickPickModel<Intent>): Promise<Intent | undefined>;
  /** Replaces the Lesson tree in the activity bar. */
  showLessonTree(model: LessonTreeModel): void;
  /** Replaces the status bar items: none while no Lesson is loaded. */
  showStatusBar(model: StatusBarModel): void;
  /** Selects the Lesson in the Lesson tree, and scrolls it into view without taking focus. */
  selectLesson(lessonId: string): void;
  /** Opens a Resource in a tab beside the code, without touching the player or taking focus. */
  openResource(target: ResourceTarget): Promise<void>;
}

// --- All of them --------------------------------------------------------------------------------

export interface Ports {
  readonly player: PlayerPort;
  readonly fileSystem: FileSystem;
  readonly storage: Storage;
  readonly clock: Clock;
  readonly converter: Converter;
  readonly config: Config;
  readonly ui: UiSink;
  readonly logger: Logger;
}
