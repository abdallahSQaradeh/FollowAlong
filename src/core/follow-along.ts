/**
 * The FollowAlong core: the headless part of the extension, reached only through its ports
 * (ADR 0002). It decides which Lesson plays and drives the player through the message protocol.
 */
import { basename, extname, join } from 'node:path';

import type { PlayerCommand, PlayerEvent } from '../protocol/player-messages.js';
import type { Disposable, FileSystem, Ports } from './ports.js';

export interface FollowAlong {
  /** Opens a Course folder and plays its first Lesson beside the code. */
  openCourse(folder: string): Promise<void>;
  dispose(): void;
}

interface Lesson {
  /** Path relative to the Course, with `/` separators. */
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The first `.webm` in natural order, files before subfolders, at any depth. FollowAlong's own
 * folder and other hidden folders are left out. The Lesson tree ticket replaces this with the
 * full Course model.
 */
async function findFirstLesson(
  fileSystem: FileSystem,
  course: string,
  folder = course,
  prefix = '',
): Promise<Lesson | undefined> {
  const entries = [...(await fileSystem.readDirectory(folder))].sort((a, b) =>
    naturalOrder.compare(a.name, b.name),
  );
  const video = entries.find(
    (entry) => entry.kind === 'file' && extname(entry.name).toLowerCase() === '.webm',
  );
  if (video !== undefined) {
    return {
      id: `${prefix}${video.name}`,
      path: join(folder, video.name),
      title: basename(video.name, extname(video.name)),
    };
  }
  for (const entry of entries) {
    if (entry.kind !== 'directory' || entry.name.startsWith('.')) {
      continue;
    }
    const found = await findFirstLesson(
      fileSystem,
      course,
      join(folder, entry.name),
      `${prefix}${entry.name}/`,
    );
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export function createFollowAlong(ports: Ports): FollowAlong {
  const { player, fileSystem, storage, ui, logger } = ports;

  /** The Lesson the player should show, with the Course it belongs to. */
  let current: { readonly course: string; readonly lesson: Lesson } | undefined;
  /** Whether the open player page has posted `ready` and takes commands. */
  let playerReady = false;

  function loadCurrent(): void {
    if (current === undefined) {
      return;
    }
    const command: PlayerCommand = {
      type: 'load',
      lessonId: current.lesson.id,
      videoUri: player.resourceUri(current.lesson.path),
      container: 'webm',
      startAt: 0,
      autoplay: true,
    };
    player.send(command);
  }

  function onPlayerEvent(event: PlayerEvent): void {
    switch (event.type) {
      case 'ready':
        playerReady = true;
        logger.log({
          level: 'debug',
          message: `Player ready (AAC ${event.aacSupported ? 'supported' : 'not supported'})`,
        });
        loadCurrent();
        break;
      case 'error':
        logger.log({
          level: 'error',
          message: `Player error in ${event.lessonId}: ${event.message}`,
        });
        if (event.lessonId === current?.lesson.id) {
          ui.showMessage({
            severity: 'error',
            text: `FollowAlong could not play “${current.lesson.title}”: ${event.message}`,
          });
        }
        break;
      case 'timeUpdate':
      case 'played':
      case 'paused':
      case 'ended':
        break;
    }
  }

  const subscriptions: Disposable[] = [player.onEvent(onPlayerEvent)];

  return {
    async openCourse(course) {
      const lesson = await findFirstLesson(fileSystem, course);
      if (lesson === undefined) {
        ui.showMessage({
          severity: 'warning',
          text: `FollowAlong found no WebM Lesson in “${basename(course)}”.`,
        });
        return;
      }
      current = { course, lesson };
      logger.log({ level: 'info', message: `Opened Course ${course}; playing ${lesson.id}` });
      const shown = player.show({ title: lesson.title, resourceRoots: [course, storage.folder] });
      if (shown === 'created') {
        playerReady = false;
      } else if (playerReady) {
        loadCurrent();
      }
    },
    dispose() {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}
