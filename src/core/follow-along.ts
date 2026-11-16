/**
 * The FollowAlong core: the headless part of the extension, reached only through its ports
 * (ADR 0002). It decides which Lesson plays and drives the player through the message protocol.
 */
import { basename, extname, join } from 'node:path';

import type { PlayerCommand, PlayerEvent } from '../protocol/player-messages.js';
import { FileSystemError, type Disposable, type FileSystem, type Ports } from './ports.js';

export interface FollowAlong {
  /** Opens a Course folder and plays its first Lesson beside the code. */
  openCourse(folder: string): Promise<void>;
  /** The play/pause command: pauses the Lesson if the player reports it playing, else plays it. */
  playPause(): void;
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
  folder: string,
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
      join(folder, entry.name),
      `${prefix}${entry.name}/`,
    );
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** What the player reported about the current Lesson since its last `load`. */
interface Playback {
  /** Whether the Lesson is playing. */
  readonly playing: boolean;
  /** Set by a `load` with autoplay, until the Lesson plays or pauses. */
  readonly awaitingAutoplay: boolean;
  /** Set when the play/pause command sent `play`, until the player answers it. */
  readonly awaitingPlayAnswer: boolean;
  /** Whether the learner was told, in this run of refusals, to press play in the player. */
  readonly toldToPressPlay: boolean;
}

function startedPlayback(autoplay: boolean): Playback {
  return {
    playing: false,
    awaitingAutoplay: autoplay,
    awaitingPlayAnswer: false,
    toldToPressPlay: false,
  };
}

function pressPlayText(lesson: Lesson): string {
  return `VS Code did not let “${lesson.title}” start by itself. Press play in the player to start it.`;
}

export function createFollowAlong(ports: Ports): FollowAlong {
  const { player, fileSystem, storage, ui, logger } = ports;

  /** The Lesson the player should show. */
  let current: Lesson | undefined;
  /** Whether the open player page has posted `ready` and takes commands. */
  let playerReady = false;
  /** What the player last said about the current Lesson; starts again with every `load`. */
  let playback = startedPlayback(false);

  function loadCurrent(): void {
    if (current === undefined) {
      return;
    }
    const command: PlayerCommand = {
      type: 'load',
      lessonId: current.id,
      videoUri: player.resourceUri(current.path),
      container: 'webm',
      startAt: 0,
      autoplay: true,
    };
    player.send(command);
    playback = startedPlayback(command.autoplay);
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
        if (event.lessonId === current?.id) {
          ui.showMessage({
            severity: 'error',
            text: `FollowAlong could not play “${current.title}”: ${event.message}`,
          });
        }
        break;
      case 'paused':
        // A pause the learner did not ask for after a `load` with autoplay, or after the command's
        // `play`: VS Code refused it. Without a word the learner would face a stopped video.
        if (event.lessonId === current?.id) {
          const refused = !event.byUser;
          const refusedAutoplay = playback.awaitingAutoplay && refused;
          // The command's `play` is refused too: VS Code lets only a click in the player start a
          // Lesson. Told once per run of refusals, so repeated keypresses do not stack messages.
          const refusedCommand =
            playback.awaitingPlayAnswer && refused && !playback.toldToPressPlay;
          if (refusedAutoplay || refusedCommand) {
            ui.showMessage({ severity: 'info', text: pressPlayText(current) });
          }
          playback = {
            playing: false,
            awaitingAutoplay: false,
            awaitingPlayAnswer: false,
            toldToPressPlay: playback.toldToPressPlay || refusedCommand,
          };
        }
        break;
      case 'played':
      case 'ended':
        if (event.lessonId === current?.id) {
          playback = { ...startedPlayback(false), playing: event.type === 'played' };
        }
        break;
      case 'timeUpdate':
        break;
    }
  }

  const subscriptions: Disposable[] = [player.onEvent(onPlayerEvent)];

  return {
    async openCourse(course) {
      let lesson: Lesson | undefined;
      try {
        lesson = await findFirstLesson(fileSystem, course);
      } catch (error) {
        if (FileSystemError.is(error, 'notFound')) {
          ui.showMessage({
            severity: 'error',
            text: `FollowAlong cannot open “${basename(course)}”: the folder is missing.`,
          });
          return;
        }
        throw error;
      }
      if (lesson === undefined) {
        ui.showMessage({
          severity: 'warning',
          text: `FollowAlong found no WebM Lesson in “${basename(course)}”.`,
        });
        return;
      }
      current = lesson;
      logger.log({ level: 'info', message: `Opened Course ${course}; playing ${lesson.id}` });
      const shown = player.show({ title: lesson.title, resourceRoots: [course, storage.folder] });
      if (shown === 'created') {
        playerReady = false;
      } else if (playerReady) {
        loadCurrent();
      }
    },
    playPause() {
      if (current === undefined) {
        ui.showMessage({
          severity: 'info',
          text: 'FollowAlong: no Lesson is open. Open a Course first.',
        });
        return;
      }
      if (!playerReady) {
        // The page is still starting: it takes no command yet, and it plays the Lesson on `ready`.
        logger.log({ level: 'debug', message: 'Play/pause ignored: the player is not ready yet.' });
        return;
      }
      playback = { ...playback, awaitingPlayAnswer: !playback.playing };
      player.send({ type: playback.playing ? 'pause' : 'play' });
    },
    dispose() {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}
