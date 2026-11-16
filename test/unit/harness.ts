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
import {
  FileSystemError,
  type Clock,
  Config,
  ConversionRequest,
  Converter,
  Disposable,
  FileSystem,
  KeyValueStore,
  PlayerPort,
  PlayerShowOptions,
  PlayerShowResult,
  Ports,
  ResourceTarget,
  Storage,
  UiSink,
  UserMessage,
} from '../../src/core/ports.js';
import type { PlayerCommand, PlayerEvent } from '../../src/protocol/player-messages.js';

/** Records what the core asks of the player and plays back scripted player events. */
export class FakePlayer implements PlayerPort {
  readonly shown: PlayerShowOptions[] = [];
  readonly sent: PlayerCommand[] = [];
  private readonly listeners = new Set<(event: PlayerEvent) => void>();
  private openRoots: readonly string[] | undefined;

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
  }

  onEvent(listener: (event: PlayerEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The learner closed the player tab. */
  close(): void {
    this.openRoots = undefined;
  }

  emit(event: PlayerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
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

  get(key: string): unknown {
    return this.values.get(key);
  }

  set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
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

  /** The learner changed a `followalong.*` setting. */
  set(name: string, value: unknown): void {
    this.values.set(name, value);
    for (const listener of this.listeners) {
      listener((changed) => changed === name);
    }
  }
}

export class RecordingUi implements UiSink {
  readonly messages: UserMessage[] = [];
  /** The Lesson tree the learner sees in the activity bar now. */
  lessonTree: LessonTreeModel | undefined;
  /** The Resources opened in a tab beside the code, in order. */
  readonly opened: ResourceTarget[] = [];
  /** Set to make opening a file fail, as VS Code does for a file that is gone. */
  openFailure: string | undefined;

  showMessage(message: UserMessage): void {
    this.messages.push(message);
  }

  showLessonTree(model: LessonTreeModel): void {
    this.lessonTree = model;
  }

  openResource(target: ResourceTarget): Promise<void> {
    if (this.openFailure !== undefined) {
      return Promise.reject(new Error(this.openFailure));
    }
    this.opened.push(target);
    return Promise.resolve();
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
  readonly core: FollowAlong;
  readonly ports: Ports;
  readonly player: FakePlayer;
  readonly clock: FakeClock;
  readonly converter: FakeConverter;
  readonly config: FakeConfig;
  readonly ui: RecordingUi;
  readonly logger: RecordingLogger;
  readonly storage: Storage;
  /** The temp dir every fixture lives in. */
  readonly root: string;
  /**
   * Makes reading `folder` fail as it does for a folder the learner may not read (Windows
   * "System Volume Information"). Containers often run as root, which reads everything, so the
   * denial is applied at the File system port with the error the Node adapter gives for EACCES.
   */
  makeUnreadable(folder: string): void;
  /** Writes a fixture folder (a Course, or any folder) under the temp dir and returns its path. */
  folder(name: string, tree: Tree): Promise<string>;
  /** Every file under `folder`, as sorted relative paths with `/`. */
  listFiles(folder: string): Promise<string[]>;
}

export async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'followalong-seam1-'));
  const player = new FakePlayer();
  const clock = new FakeClock();
  const converter = new FakeConverter();
  const config = new FakeConfig();
  const ui = new RecordingUi();
  const logger = new RecordingLogger();
  const storage: Storage = {
    global: new MemoryStore(),
    workspace: new MemoryStore(),
    folder: join(root, 'extension-storage'),
  };
  const nodeFileSystem = createNodeFileSystem();
  const unreadable = new Set<string>();
  const fileSystem: FileSystem = {
    ...nodeFileSystem,
    readDirectory(path) {
      if (unreadable.has(path)) {
        return Promise.reject(
          new FileSystemError('readOnly', path, `EACCES: permission denied, scandir '${path}'`),
        );
      }
      return nodeFileSystem.readDirectory(path);
    },
  };
  const ports: Ports = {
    player,
    fileSystem,
    storage,
    clock,
    converter,
    config,
    ui,
    logger,
  };
  const core = createFollowAlong(ports);
  onTestFinished(async () => {
    core.dispose();
    await rm(root, { recursive: true, force: true });
  });

  return {
    core,
    ports,
    player,
    clock,
    converter,
    config,
    ui,
    logger,
    storage,
    root,
    makeUnreadable(folder) {
      unreadable.add(folder);
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
  };
}
