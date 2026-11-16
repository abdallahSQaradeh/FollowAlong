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
import type { VideoSpot } from './video-placement.js';

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
  /**
   * Where the player sits. A player open in another spot moves there: the adapter makes a new
   * player page in the new spot and drops the old one, which is not a close (ADR 0049).
   */
  readonly spot: VideoSpot;
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
  /**
   * Collapses the player: its page is dropped and nothing shows, but this is not a close, so
   * `onDidClose` stays quiet and the Lesson is still loaded. The next `show` brings a new page
   * back (ADR 0092).
   */
  collapse(): void;
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

/** Gives back a lock taken with {@link FileSystem.lock}. */
export type ReleaseLock = () => Promise<void>;

/** Every method rejects with a {@link FileSystemError}. */
export interface FileSystem {
  readDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  /** The size and last change of a file or folder. */
  stat(path: string): Promise<FileStat>;
  /**
   * The folders the Folder browser starts from when the learner named no Courses root (ADR 0066):
   * the drives of a Windows machine that are there now (`C:\`, `D:\`), the learner's home folder
   * elsewhere. Absolute paths; empty if there are none. Never rejects: a drive that cannot be
   * looked at is left out.
   */
  startingFolders(): Promise<readonly string[]>;
  readText(path: string): Promise<string>;
  /**
   * Whether anything is at `path`. It resolves `false` only when nothing is there (`notFound`); a
   * path that cannot be looked at for another reason counts as present, because only a file that
   * is surely gone is shown as missing and offered for a relink.
   */
  exists(path: string): Promise<boolean>;
  /** Writes the whole file at once: readers see the old or the new content, never a mix. */
  writeText(path: string, content: string): Promise<void>;
  /**
   * Deletes the file at `path` (never a folder): `notFound` when nothing is there, `readOnly` when
   * it may not be deleted. On Windows a file another process holds open may refuse for a moment.
   */
  remove(path: string): Promise<void>;
  /**
   * Takes the lock of the file at `path`, so that two VS Code windows reading and rewriting it take
   * turns (ADR 0074): makes `<path>.lock` beside it, waiting a moment while another window holds
   * it, and taking over a lock left behind by a window that stopped. Resolves with the function
   * that gives it back. Rejects when the lock is still held after the wait, or cannot be made
   * there (`readOnly`, `notFound`).
   */
  lock(path: string): Promise<ReleaseLock>;
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
  /** Whether this window has no folder and no workspace file open (a new empty window). */
  readonly workspaceIsEmpty: boolean;
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
  /**
   * Whether ffmpeg runs at a lower process priority than the editor, so a conversion never makes
   * the machine feel slow while the learner works (spec #12, story 68). The core asks for it for
   * every conversion; the adapter does what its platform allows, and a refusal never fails the
   * conversion.
   */
  readonly lowPriority: boolean;
  readonly onProgress: (percent: number) => void;
  readonly signal: AbortSignal;
}

export interface SoundProbe {
  /** The ffmpeg to run: a path, or a command name looked up on PATH. */
  readonly program: string;
  /** The Lesson video whose sound is asked about. */
  readonly input: string;
  readonly signal: AbortSignal;
}

export interface Converter {
  /**
   * The codec of the video's first sound track, as ffmpeg names it (`aac`, `mp3`, `opus`, …), or
   * `undefined` when the video has no sound. Rejects when the video cannot be read.
   */
  soundCodec(probe: SoundProbe): Promise<string | undefined>;
  /**
   * Writes `output` and resolves, or rejects with the reason it could not. `output` appears only
   * once it is whole, so a file found there is a finished conversion. Aborting `signal` stops the
   * conversion, leaves no `output`, and rejects. A folder that cannot be written rejects with a
   * {@link FileSystemError} `readOnly`, before anything is converted.
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
 * What a Resource opens as. The core picks the kind from the file's type (`resourceTarget`), or
 * `url` for a URL Resource; the adapter turns each kind into a tab beside the code.
 */
export type ResourceTarget =
  | {
      /**
       * - `file`: text and code, and any type FollowAlong has no better opener for: the editor;
       * - `image`: VS Code's image preview;
       * - `markdown`, `html`: a rendered preview;
       * - `pdf`: the FollowAlong PDF viewer.
       */
      readonly kind: 'file' | 'image' | 'markdown' | 'html' | 'pdf';
      readonly path: string;
    }
  | {
      /** A web page, in VS Code's Simple Browser. The core has checked that it is `http` or `https`. */
      readonly kind: 'url';
      readonly url: string;
    };

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

/** A dialog in which the learner chooses one file. */
export interface FileDialog {
  readonly title: string;
  /** The label of the button that chooses the file. */
  readonly openLabel: string;
}

/** A box in which the learner types one line of text. */
export interface TextPrompt {
  readonly title: string;
  /** Tells the learner what to type. */
  readonly prompt: string;
  readonly placeholder: string;
  /**
   * What is wrong with the text as typed so far, shown under the box while the learner types, or
   * `undefined` when it is fine. The box cannot be confirmed while it answers a problem.
   */
  readonly validate: (text: string) => string | undefined;
}

/** A quick pick that stays open while the core replaces what it lists. */
export interface LivePicker<Intent> {
  /**
   * Resolves with the intent of the item the learner picked, or of an item button they pressed,
   * or `undefined` when they closed the quick pick without picking.
   */
  readonly answer: Promise<Intent | undefined>;
  /**
   * Replaces what the quick pick lists and whether it is busy, keeping what the learner typed.
   * Does nothing once the quick pick is closed.
   */
  update(model: QuickPickModel<Intent>): void;
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
  /**
   * Shows a quick pick whose list the core may replace while it is open (the Course picker, which
   * opens from a cache and updates when the rescan is done). `onStayOpen` gets the intent of a
   * title bar button, or an item or item button that `keepsOpen` (a folder of the Folder browser, a
   * Hide) that the learner presses; the quick pick stays open.
   */
  openPicker<Intent>(
    model: QuickPickModel<Intent>,
    onStayOpen: (intent: Intent) => void,
  ): LivePicker<Intent>;
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
  /**
   * Opens a new, empty window of the editor (no folder in it), so that a Course can be opened
   * there without touching the Practice area. Rejects when the editor refuses.
   */
  openNewWindow(): Promise<void>;
  /** Asks the learner for one folder; resolves with its absolute path, or `undefined` on cancel. */
  chooseFolder(dialog: FolderDialog): Promise<string | undefined>;
  /**
   * Opens a file dialog (for an Attach, or a Relink) and resolves with the absolute path of the
   * file the learner picked, or `undefined` when they closed it without picking. The dialog is
   * not modal to the player: the Lesson keeps playing while it is open.
   */
  pickFile(dialog: FileDialog): Promise<string | undefined>;
  /** Asks for one line of text; resolves with it, or `undefined` when the learner closed the box. */
  askText(prompt: TextPrompt): Promise<string | undefined>;
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
  /**
   * The full path of the ffmpeg this extension ships, where one exists for the machine it runs on
   * (the .vsix is Windows x64 only), whether or not the file is still there. Absent elsewhere: the
   * core then runs the ffmpeg on PATH. `followalong.ffmpegPath` overrides it (ADR 0071).
   */
  readonly bundledFfmpeg?: string | undefined;
}
