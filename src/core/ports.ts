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
  /**
   * Absolute folders the player may read media from: the Courses roots, the Course when it is
   * outside them, and the fallback root of Course data (ADR 0022, ADR 0025).
   */
  readonly resourceRoots: readonly string[];
}

/**
 * - `created`: a new player page is starting (in a new player, or in the open one with other
 *   resource roots); it posts `ready` once it can take commands.
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

/** What `stat` tells about a file. */
export interface FileStat {
  readonly size: number;
  /** When the file was last changed, in milliseconds since the epoch. */
  readonly modifiedMs: number;
}

/** Every method rejects with a {@link FileSystemError}. */
export interface FileSystem {
  readDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  /** The size and last change of a file or folder. */
  stat(path: string): Promise<FileStat>;
  readText(path: string): Promise<string>;
  /** Writes the whole file at once: readers see the old or the new content, never a mix. */
  writeText(path: string, content: string): Promise<void>;
  /**
   * Creates the folder, and its missing parents too when `parents` is set; without it, a missing
   * parent fails with `notFound`. A folder that already exists is fine. `hidden` also sets the
   * Windows hidden attribute.
   */
  makeDirectory(
    path: string,
    options: { readonly hidden: boolean; readonly parents: boolean },
  ): Promise<void>;
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
  /** The ffmpeg to run: a path, or a command name looked up on PATH. */
  readonly program: string;
  /** The Lesson video to read the sound from. */
  readonly input: string;
  /** The sound file to write. */
  readonly output: string;
  readonly onProgress: (percent: number) => void;
  readonly signal: AbortSignal;
}

export interface Converter {
  /**
   * Writes `output` and resolves, or rejects with the reason it could not. `output` appears only
   * once it is whole, so a file found there is a finished conversion. Aborting `signal` stops the
   * conversion, leaves no `output`, and rejects.
   */
  extractSound(request: ConversionRequest): Promise<void>;
}

// --- Config -------------------------------------------------------------------------------------

export interface Config {
  /** The value of a `followalong.*` setting, by its name without the prefix. */
  get(name: string): unknown;
  /** Writes a `followalong.*` setting, by its name without the prefix, in the user settings. */
  update(name: string, value: unknown): Promise<void>;
  /** Calls `listener` with a check for which settings changed. */
  onDidChange(listener: (affects: (name: string) => boolean) => void): Disposable;
}

// --- UI sink ------------------------------------------------------------------------------------

export interface UserMessage {
  readonly severity: 'info' | 'warning' | 'error';
  readonly text: string;
}

/**
 * What a Resource opens as. The core picks the kind from the file's type (`resourceTarget`); the
 * adapter turns each kind into a tab beside the code. A URL target comes with its own ticket.
 */
export interface ResourceTarget {
  /**
   * - `file`: text and code, and any type FollowAlong has no better opener for: the editor;
   * - `image`: VS Code's image preview;
   * - `markdown`, `html`: a rendered preview;
   * - `pdf`: the FollowAlong PDF viewer.
   */
  readonly kind: 'file' | 'image' | 'markdown' | 'html' | 'pdf';
  readonly path: string;
}

/** The two answers to a {@link Question}: the button that agrees, and the one that declines. */
export type Answer = 'accept' | 'decline';

/** A question with two answers, put to the learner without blocking what they are doing. */
export interface Question {
  readonly text: string;
  /** The label of the button that agrees. */
  readonly accept: string;
  /** The label of the button that declines. */
  readonly decline: string;
}

/** A dialog in which the learner chooses one folder. */
export interface FolderDialog {
  readonly title: string;
  /** The label of the button that chooses the folder. */
  readonly openLabel: string;
}

export interface UiSink {
  showMessage(message: UserMessage): void;
  /**
   * Asks the learner a question and resolves with the button they pressed, or `undefined` when
   * they closed it, or let it go, without answering.
   */
  ask(question: Question): Promise<Answer | undefined>;
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
  /**
   * Hands keyboard focus back to the editor or terminal the learner used last, so a click in
   * the player is not a Focus change (ADR 0009).
   */
  returnFocus(): void;
  /** Asks the learner for one folder; resolves with its absolute path, or `undefined` on cancel. */
  chooseFolder(dialog: FolderDialog): Promise<string | undefined>;
  /**
   * Opens the file dialog for an Attach and resolves with the absolute path of the file the
   * learner picked, or `undefined` when they closed it without picking. The dialog is not
   * modal to the player: the Lesson keeps playing while it is open.
   */
  pickFile(): Promise<string | undefined>;
}

// --- Terminal settings ----------------------------------------------------------------------------

/**
 * The learner's own VS Code setting `terminal.integrated.commandsToSkipShell`: the commands whose
 * keys VS Code keeps for itself instead of sending them to the shell (spec #12, story 45). Only
 * the user-level value is read and written, never a workspace's: the Practice area is never
 * changed.
 */
export interface TerminalSettings {
  /** The user-level value as stored: `undefined` when the learner never set it. */
  skipShellCommands(): unknown;
  /** Replaces the user-level value. */
  setSkipShellCommands(commands: readonly string[]): Promise<void>;
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
  readonly terminalSettings: TerminalSettings;
}
