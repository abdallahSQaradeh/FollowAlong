/**
 * Seam 1 harness (spec #12, Testing Decisions). Builds the FollowAlong core with a fake player,
 * fake clock, fake converter, in-memory storage, fake config and a recording UI sink and logger,
 * over the real Node file system in a temp dir. Fixture Course trees are written into that dir.
 */
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { onTestFinished } from 'vitest';

import { createNodeFileSystem } from '../../src/adapters/node/file-system.js';
import { createFollowAlong, type FollowAlong } from '../../src/core/follow-along.js';
import type { LessonTreeModel } from '../../src/core/lesson-tree.js';
import type { LogEntry, Logger } from '../../src/core/logger.js';
import type { QuickPickModel } from '../../src/core/quick-pick.js';
import type { StatusBarModel } from '../../src/core/status-bar.js';
import {
  FileSystemError,
  type Answer,
  type Clock,
  Config,
  ConversionRequest,
  Converter,
  Disposable,
  FileDialog,
  FileSystem,
  FolderDialog,
  KeyValueStore,
  PlayerPort,
  PlayerShowOptions,
  PlayerShowResult,
  Ports,
  ResourceTarget,
  Question,
  Storage,
  TerminalSettings,
  UiSink,
  UserMessage,
} from '../../src/core/ports.js';
import type { PlayerCommand, PlayerEvent } from '../../src/protocol/player-messages.js';

/** Records what the core asks of the player and plays back scripted player events. */
export class FakePlayer implements PlayerPort {
  readonly shown: PlayerShowOptions[] = [];
  readonly sent: PlayerCommand[] = [];
  private readonly listeners = new Set<(event: PlayerEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private openRoots: readonly string[] | undefined;
  /** The `loadId` of the last `load` the page received. */
  private loadId: number | undefined;

  show(options: PlayerShowOptions): PlayerShowResult {
    this.shown.push(options);
    const same =
      this.openRoots?.length === options.resourceRoots.length &&
      this.openRoots.every((root, index) => root === options.resourceRoots[index]);
    this.openRoots = options.resourceRoots;
    return same ? 'revealed' : 'created';
  }

  resourceUri(absolutePath: string): string {
    return `fake-resource:${absolutePath.split(sep).join('/')}`;
  }

  send(command: PlayerCommand): void {
    this.sent.push(command);
    if (command.type === 'load') {
      this.loadId = command.loadId;
    }
  }

  onEvent(listener: (event: PlayerEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Forgets the commands sent so far, so a test can look at what comes next. */
  clearSent(): void {
    this.sent.length = 0;
  }

  onDidClose(listener: () => void): Disposable {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  /** The learner closed the player tab. */
  close(): void {
    this.openRoots = undefined;
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  /**
   * The page reports an event. An event about a Lesson carries the `loadId` of the page's last
   * `load`, as the real page echoes it, unless the test gives one (a late event from an earlier
   * load).
   */
  emit(event: PlayerEvent): void {
    const stamped =
      'lessonId' in event && !('loadId' in event) && this.loadId !== undefined
        ? { ...event, loadId: this.loadId }
        : event;
    for (const listener of this.listeners) {
      listener(stamped);
    }
  }

  /** The player page finished loading (stock Chromium in VS Code cannot play AAC). */
  ready(aacSupported = false): void {
    this.emit({ type: 'ready', aacSupported });
  }
}

export class FakeClock implements Clock {
  private time = Date.UTC(2026, 10, 15, 9, 0, 0);
  private readonly timers = new Set<{ at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  schedule(delayMs: number, callback: () => void): Disposable {
    const timer = { at: this.time + delayMs, callback };
    this.timers.add(timer);
    return { dispose: () => this.timers.delete(timer) };
  }

  /** Moves time forward, running every timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at);
      const next = due[0];
      if (next === undefined) {
        break;
      }
      this.timers.delete(next);
      this.time = next.at;
      next.callback();
    }
    this.time = end;
  }
}

/** Each request waits for the test to report progress, succeed or fail it. */
export class FakeConverter implements Converter {
  readonly requests: { request: ConversionRequest; succeed(): void; fail(reason: string): void }[] =
    [];

  extractSound(request: ConversionRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      this.requests.push({
        request,
        succeed: resolve,
        fail: (reason) => {
          reject(new Error(reason));
        },
      });
    });
  }
}

class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, unknown>();

  /**
   * `settlesLater`: the promise of `set` settles on a later turn, as a VS Code memento's does once
   * it is on disk, so a test can reach the moments in between (a Course open stores its folder).
   */
  constructor(private readonly settlesLater = false) {}

  get(key: string): unknown {
    return this.values.get(key);
  }

  set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    const gate = this.gate;
    if (gate !== undefined) {
      this.gate = undefined;
      gate.reach();
      return gate.released;
    }
    return this.settlesLater ? new Promise((resolve) => setImmediate(resolve)) : Promise.resolve();
  }

  private gate: { readonly reach: () => void; readonly released: Promise<void> } | undefined;

  /**
   * Holds the next `set` until `release` is called, as a slow disk would. `reached` settles when
   * that `set` has been called, so a test can act at exactly that moment.
   */
  holdNextSet(): { readonly reached: Promise<void>; release(): void } {
    let reach = (): void => undefined;
    let release = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { reach, released };
    return { reached, release };
  }
}

export class FakeConfig implements Config {
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Set<(affects: (name: string) => boolean) => void>();

  get(name: string): unknown {
    return this.values.get(name);
  }

  onDidChange(listener: (affects: (name: string) => boolean) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** FollowAlong writes a setting in the learner's user settings. */
  update(name: string, value: unknown): Promise<void> {
    this.set(name, structuredClone(value));
    return Promise.resolve();
  }

  /** The learner changed a `followalong.*` setting. */
  set(name: string, value: unknown): void {
    this.values.set(name, value);
    for (const listener of this.listeners) {
      listener((changed) => changed === name);
    }
  }
}

/** The learner's user-level `terminal.integrated.commandsToSkipShell`, and what was written to it. */
export class FakeTerminalSettings implements TerminalSettings {
  /** The stored value: `undefined` until the learner sets it. */
  value: unknown;
  /** Every value written, in order. */
  readonly writes: (readonly string[])[] = [];
  /** Set to make writing fail, as VS Code does when settings.json cannot be saved. */
  writeFailure: string | undefined;

  skipShellCommands(): unknown {
    return this.value;
  }

  setSkipShellCommands(commands: readonly string[]): Promise<void> {
    if (this.writeFailure !== undefined) {
      return Promise.reject(new Error(this.writeFailure));
    }
    this.writes.push(commands);
    this.value = [...commands];
    return Promise.resolve();
  }
}

export class RecordingUi implements UiSink {
  readonly messages: UserMessage[] = [];
  /** Every question the core asked, in order. */
  readonly questions: Question[] = [];
  private questionAnswer: ((answer: Answer | undefined) => void) | undefined;
  /** The Lesson tree the learner sees in the activity bar now. */
  lessonTree: LessonTreeModel | undefined;
  /** How many times the core replaced the Lesson tree: each one is a redraw of the tree view. */
  lessonTreeDraws = 0;
  /** The status bar items the learner sees now; none until the core shows some. */
  statusBar: StatusBarModel = { items: [] };
  /** The id of the Lesson the tree shows as selected. */
  selectedLesson: string | undefined;
  /** The Resources opened in a tab beside the code, in order. */
  readonly opened: ResourceTarget[] = [];
  /** Set to make opening a file fail, as VS Code does for a file that is gone. */
  openFailure: string | undefined;
  /** Every quick pick the core opened, in order. */
  readonly pickers: QuickPickModel<unknown>[] = [];
  private answer: ((intent: unknown) => void) | undefined;
  private readonly pickerWaiters: (() => void)[] = [];
  /** How many times the core asked to hand keyboard focus back to the Practice area. */
  focusReturns = 0;
  /** Every folder dialog the core opened, in order. */
  readonly folderDialogs: FolderDialog[] = [];
  /** The folders the learner will choose in the next folder dialogs; none left is a cancel. */
  readonly folderAnswers: string[] = [];
  /** Every file dialog the core opened (for an Attach or a Relink), in order. */
  readonly fileDialogRequests: FileDialog[] = [];
  /** How many file dialogs the core opened. */
  get fileDialogs(): number {
    return this.fileDialogRequests.length;
  }
  private fileAnswer: ((path: string | undefined) => void) | undefined;

  showMessage(message: UserMessage): void {
    this.messages.push(message);
  }

  ask(question: Question): Promise<Answer | undefined> {
    this.questions.push(question);
    return new Promise((resolve) => {
      this.questionAnswer = resolve;
    });
  }

  /** The learner answers the open question: a button, or `undefined` for closing it. */
  answerQuestion(answer: Answer | undefined): void {
    const resolve = this.questionAnswer;
    if (resolve === undefined) {
      throw new Error('No question is open');
    }
    this.questionAnswer = undefined;
    resolve(answer);
  }

  pick<Intent>(model: QuickPickModel<Intent>): Promise<Intent | undefined> {
    this.pickers.push(model);
    const shown = new Promise<Intent | undefined>((resolve) => {
      this.answer = (intent) => {
        resolve(intent as Intent | undefined);
      };
    });
    for (const waiter of this.pickerWaiters.splice(0)) {
      waiter();
    }
    return shown;
  }

  /**
   * Resolves once a quick pick is open: at once if one is, else when the core opens the next one
   * (after it has read what it lists), so a test never guesses how long that takes.
   */
  pickerShown(): Promise<void> {
    return this.answer === undefined
      ? new Promise((resolve) => {
          this.pickerWaiters.push(resolve);
        })
      : Promise.resolve();
  }

  /** The quick pick the learner sees now, if one is open. */
  get picker(): QuickPickModel<unknown> | undefined {
    return this.answer === undefined ? undefined : this.pickers.at(-1);
  }

  /** The learner picks the open quick pick's item with this label. */
  choose(label: string): void {
    const item = this.picker?.entries.find(
      (entry) => entry.kind === 'item' && entry.label === label,
    );
    if (this.answer === undefined || item?.kind !== 'item') {
      throw new Error(`No item “${label}” in the open quick pick`);
    }
    const answer = this.answer;
    this.answer = undefined;
    answer(item.intent);
  }

  /** The learner closes the quick pick without picking. */
  dismissPicker(): void {
    const answer = this.answer;
    this.answer = undefined;
    answer?.(undefined);
  }

  showLessonTree(model: LessonTreeModel): void {
    this.lessonTreeDraws += 1;
    this.lessonTree = model;
  }

  showStatusBar(model: StatusBarModel): void {
    this.statusBar = model;
  }

  selectLesson(lessonId: string): void {
    this.selectedLesson = lessonId;
  }

  openResource(target: ResourceTarget): Promise<void> {
    if (this.openFailure !== undefined) {
      return Promise.reject(new Error(this.openFailure));
    }
    this.opened.push(target);
    return Promise.resolve();
  }

  returnFocus(): void {
    this.focusReturns += 1;
  }

  chooseFolder(dialog: FolderDialog): Promise<string | undefined> {
    this.folderDialogs.push(dialog);
    return Promise.resolve(this.folderAnswers.shift());
  }

  pickFile(dialog: FileDialog): Promise<string | undefined> {
    this.fileDialogRequests.push(dialog);
    return new Promise((resolve) => {
      this.fileAnswer = resolve;
    });
  }

  /** Whether a file dialog is open now. */
  get fileDialogOpen(): boolean {
    return this.fileAnswer !== undefined;
  }

  /** The learner picks this file in the open file dialog, or `undefined` for closing it. */
  answerFileDialog(path: string | undefined): void {
    const resolve = this.fileAnswer;
    if (resolve === undefined) {
      throw new Error('No file dialog is open');
    }
    this.fileAnswer = undefined;
    resolve(path);
  }
}

export class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  log(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

/** A fixture tree: relative file path (with `/`) → file content. */
export type Tree = Readonly<Record<string, string>>;

export interface Harness {
  /** The core of the VS Code window under test; {@link Harness.restart} replaces it. */
  readonly core: FollowAlong;
  readonly ports: Ports;
  /** The player of the window under test; {@link Harness.restart} replaces it. */
  readonly player: FakePlayer;
  readonly clock: FakeClock;
  readonly converter: FakeConverter;
  readonly config: FakeConfig;
  readonly ui: RecordingUi;
  readonly logger: RecordingLogger;
  readonly terminalSettings: FakeTerminalSettings;
  readonly storage: Storage;
  /** The temp dir every fixture lives in. */
  readonly root: string;
  /**
   * Makes reading `folder` (or a file) fail as it does for a folder the learner may not read
   * (Windows "System Volume Information"). Containers often run as root, which reads everything,
   * so the denial is applied at the File system port with the error the Node adapter gives for
   * EACCES.
   */
  makeUnreadable(folder: string): void;
  /**
   * Holds every read of `folder`'s listing until the returned function is called, as a slow disk
   * or network drive would, so a test can make reads finish in another order than they started.
   */
  holdReads(folder: string): () => void;
  /**
   * Holds every read of the file at `path` until the returned function is called, as a slow disk
   * would; `reached` settles once a read has started.
   */
  holdFileReads(path: string): { readonly reached: Promise<void>; release(): void };
  /**
   * Holds the next write to the workspace state (a Course open stores its folder there) until
   * `release` is called; `reached` settles once the write has started.
   */
  holdWorkspaceWrite(): { readonly reached: Promise<void>; release(): void };
  /** Undoes {@link Harness.makeUnreadable}: the path reads as usual again. */
  makeReadable(path: string): void;
  /** Writes a fixture folder (a Course, or any folder) under the temp dir and returns its path. */
  folder(name: string, tree: Tree): Promise<string>;
  /** Every file under `folder`, as sorted relative paths with `/`. */
  listFiles(folder: string): Promise<string[]>;
  /**
   * Waits until every file system call the core started has finished, including calls those
   * calls lead to (a save creates the folder, then writes the file).
   */
  settle(): Promise<void>;
  /**
   * VS Code starts again on the same workspace: a new core and a new player page, over the same
   * disk and the same global and workspace storage. The old core is dropped (`dispose`) as a
   * crash would drop it; call `close()` on it first for a clean window close.
   */
  restart(): void;
}

export async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'followalong-seam1-'));
  const player = new FakePlayer();
  const clock = new FakeClock();
  const converter = new FakeConverter();
  const config = new FakeConfig();
  const ui = new RecordingUi();
  const logger = new RecordingLogger();
  const terminalSettings = new FakeTerminalSettings();
  const workspace = new MemoryStore(true);
  const storage: Storage = {
    global: new MemoryStore(),
    workspace,
    folder: join(root, 'extension-storage'),
  };
  const nodeFileSystem = createNodeFileSystem();
  const unreadable = new Set<string>();
  const held = new Map<string, Promise<void>>();
  const heldFiles = new Map<
    string,
    { readonly reach: () => void; readonly released: Promise<void> }
  >();
  const inFlight = new Set<Promise<unknown>>();
  /** Counts a call until it settles, so `settle()` can wait for it. */
  const track = <T>(call: Promise<T>): Promise<T> => {
    inFlight.add(call);
    const done = () => inFlight.delete(call);
    call.then(done, done);
    return call;
  };
  const fileSystem: FileSystem = {
    readDirectory(path) {
      const read = (): ReturnType<FileSystem['readDirectory']> =>
        unreadable.has(path)
          ? Promise.reject(
              new FileSystemError('readOnly', path, `EACCES: permission denied, scandir '${path}'`),
            )
          : nodeFileSystem.readDirectory(path);
      const hold = held.get(path);
      return track(hold === undefined ? read() : hold.then(read));
    },
    readText(path) {
      if (unreadable.has(path)) {
        return Promise.reject(
          new FileSystemError('readOnly', path, `EACCES: permission denied, open '${path}'`),
        );
      }
      const hold = heldFiles.get(path);
      hold?.reach();
      return track(
        hold === undefined
          ? nodeFileSystem.readText(path)
          : hold.released.then(() => nodeFileSystem.readText(path)),
      );
    },
    exists: (path) => track(nodeFileSystem.exists(path)),
    writeText: (path, content) => track(nodeFileSystem.writeText(path, content)),
    makeDirectory: (path, options) => track(nodeFileSystem.makeDirectory(path, options)),
  };
  const portsFor = (windowPlayer: FakePlayer): Ports => ({
    player: windowPlayer,
    fileSystem,
    storage,
    clock,
    converter,
    config,
    ui,
    logger,
    terminalSettings,
  });
  const cores: FollowAlong[] = [];
  onTestFinished(async () => {
    for (const core of cores) {
      core.dispose();
    }
    // A save still under way would write into the temp dir while it is being removed.
    await harness.settle();
    await rm(root, { recursive: true, force: true });
  });
  const start = (windowPlayer: FakePlayer): FollowAlong => {
    const core = createFollowAlong(portsFor(windowPlayer));
    cores.push(core);
    return core;
  };

  const harness: Harness = {
    core: start(player),
    ports: portsFor(player),
    player,
    clock,
    converter,
    config,
    ui,
    logger,
    terminalSettings,
    storage,
    root,
    makeUnreadable(folder) {
      unreadable.add(folder);
    },
    holdWorkspaceWrite() {
      return workspace.holdNextSet();
    },
    holdReads(folder) {
      let release = (): void => undefined;
      held.set(
        folder,
        new Promise((resolve) => {
          release = () => {
            held.delete(folder);
            resolve();
          };
        }),
      );
      return () => {
        release();
      };
    },
    holdFileReads(path) {
      let reach = (): void => undefined;
      let release = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = () => {
          // Only this hold: a later hold of the same file stays until its own release.
          if (heldFiles.get(path)?.released === released) {
            heldFiles.delete(path);
          }
          resolve();
        };
      });
      heldFiles.set(path, { reach, released });
      return { reached, release };
    },
    makeReadable(path) {
      unreadable.delete(path);
    },
    async folder(name, tree) {
      const folder = join(root, name);
      await mkdir(folder, { recursive: true });
      for (const [path, content] of Object.entries(tree)) {
        const file = join(folder, ...path.split('/'));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
      }
      return folder;
    },
    async listFiles(folder) {
      const entries = await readdir(folder, { recursive: true, withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/'))
        .sort();
    },
    async settle() {
      for (;;) {
        // A finished call's continuation may start the next call; let it run first.
        await new Promise((resolve) => setImmediate(resolve));
        if (inFlight.size === 0) {
          return;
        }
        await Promise.allSettled([...inFlight]);
      }
    },
    restart() {
      harness.core.dispose();
      const windowPlayer = new FakePlayer();
      Object.assign(harness, {
        core: start(windowPlayer),
        player: windowPlayer,
        ports: portsFor(windowPlayer),
      });
    },
  };
  return harness;
}
