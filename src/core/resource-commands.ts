/**
 * The Resource commands: attach a file or a URL to a Lesson or to the whole Course, open, detach and
 * relink a Resource. Each fixes the open Course and its Resources when it runs, before any dialog
 * is awaited (ADR 0024), and the Lesson tree then shows what is there now.
 */
import { basename } from 'node:path';

import { lessonsInOrder, type Course, type Lesson } from './course-model.js';
import { messageOf } from './logger.js';
import type { Ports } from './ports.js';
import type { ResourceStore } from './resource-store.js';
import {
  attachChoice,
  checkWebUrl,
  resourceName,
  resourcePath,
  resourceTarget,
  urlLabel,
  type ResourceRecord,
} from './resources.js';

/** What a Resource is attached to: the whole Course, or one of its Lessons. */
type AttachTarget =
  { readonly kind: 'course' } | { readonly kind: 'lesson'; readonly lessonId: string };

export interface ResourceCommands {
  /**
   * Attaches a file, from anywhere on disk, as a Resource of a Lesson of the open Course: the
   * tree's "+". Without `absolutePath` it first asks for the file; the Lesson and its Course are
   * fixed when the command runs, so a Course opened while the dialog is up never receives it.
   */
  attachResource(lessonId: string, absolutePath?: string): Promise<void>;
  /**
   * Attaches a file, from anywhere on disk, as a Resource of the whole open Course: the "+" on the
   * Course node. Without `absolutePath` it first asks for the file; the Course is fixed when the
   * command runs, so a Course opened while the dialog is up never receives it.
   */
  attachCourseResource(absolutePath?: string): Promise<void>;
  /**
   * The attach command from the chord or the Command Palette: asks for a file and attaches it to
   * the Loaded Lesson when the command runs. The Lesson keeps playing meanwhile.
   */
  attachToLoadedLesson(): Promise<void>;
  /** Opens a Resource of the open Course, by its tree id, in a tab beside the code. */
  openResource(resourceId: string): Promise<void>;
  /**
   * Detaches a Resource of the open Course, by its tree id: the reference goes, the file on disk
   * stays. The Course is fixed when the command runs.
   */
  detachResource(resourceId: string): Promise<void>;
  /**
   * Points a Resource of the open Course, by its tree id, at another file. Without `absolutePath`
   * it first asks for the file; the Course is fixed when the command runs, so a Course opened
   * while the dialog is up never has the Resource relinked.
   */
  relinkResource(resourceId: string, absolutePath?: string): Promise<void>;
}

/** What the Resource commands read from the rest of the core when they run. */
export interface OpenCourseResources {
  /** The open Course, if any. */
  readonly course: () => Course | undefined;
  /** The open Course's Resources, once they are read. */
  readonly store: () => ResourceStore | undefined;
  /** The Loaded Lesson, if any: always one of the open Course's. */
  readonly loadedLesson: () => Lesson | undefined;
  /**
   * Draws the open Course's tree with `store`'s Resources; does nothing when the learner would see
   * the same tree.
   */
  readonly drawTreeWith: (store: ResourceStore) => void;
}

export function createResourceCommands(
  ports: Pick<Ports, 'ui' | 'logger'>,
  open: OpenCourseResources,
): ResourceCommands {
  const { ui, logger } = ports;

  /**
   * Draws the Resources of `store` in the tree, if its Course is the one open now. A change is
   * made in the data of the Course it was asked in, even if the learner has opened another Course
   * since; the tree then keeps showing that other Course.
   */
  function showResources(course: Course, store: ResourceStore): boolean {
    if (open.course()?.folder !== course.folder) {
      return false;
    }
    open.drawTreeWith(store);
    return true;
  }

  /**
   * After a Resources change was tried: the tree shows what is there now (also when the change no
   * longer applied, because another window got there first). A change made in a Course that is no
   * longer open is said, because the tree shows another Course and the learner might do it again.
   */
  function showResourceChange(
    course: Course,
    store: ResourceStore,
    change: { readonly made: boolean; readonly said: string },
  ): void {
    if (!showResources(course, store) && change.made) {
      ui.showMessage({
        severity: 'info',
        text: `FollowAlong ${change.said} in “${basename(course.folder)}”, which is no longer open.`,
      });
    }
  }

  /**
   * The open Course, its Resources and one of them, as a Resource command finds them when it runs.
   * That fixes the Course before any dialog is awaited (ADR 0024).
   */
  function resourceOfOpenCourse(
    resourceId: string,
    action: string,
  ): { course: Course; store: ResourceStore; record: ResourceRecord } | undefined {
    const course = open.course();
    const store = open.store();
    const record = store?.find(resourceId);
    if (course === undefined || store === undefined || record === undefined) {
      logger.log({
        level: 'warn',
        message: `Cannot ${action} ${resourceId}: it is not a Resource of the open Course.`,
      });
      return undefined;
    }
    return { course, store, record };
  }

  /**
   * Every attach route (a Lesson from its "+" or the chord, the whole Course from its "+"), once
   * it has fixed what the Resource goes to and that Course: asks whether it is a file or a URL and
   * for which one, when none is given yet, then attaches it. A closed choice, dialog or box attaches
   * nothing. A file given up front (by a drop or a test) skips the choice.
   */
  async function attachTo(
    course: Course,
    store: ResourceStore,
    target: AttachTarget,
    absolutePath?: string,
  ): Promise<void> {
    const where =
      target.kind === 'course'
        ? 'the Course'
        : `“${lessonsInOrder(course).find((lesson) => lesson.id === target.lessonId)?.title ?? target.lessonId}”`;
    if (absolutePath === undefined) {
      const choice = await ui.pick(attachChoice(target.kind));
      if (choice === undefined) {
        return;
      }
      if (choice === 'url') {
        await attachUrlTo(course, store, target, where);
        return;
      }
    }
    const path =
      absolutePath ??
      (await ui.pickFile({
        title:
          target.kind === 'course'
            ? 'Attach a file to this Course'
            : 'Attach a file to this Lesson',
        openLabel: 'Attach',
      }));
    if (path === undefined) {
      return;
    }
    const made =
      target.kind === 'course'
        ? await store.attachToCourse(path)
        : await store.attach(target.lessonId, path);
    showResourceChange(course, store, { made, said: `attached “${basename(path)}” to ${where}` });
  }

  /** The “URL…” half of {@link attachTo}: asks for the address, checks it, and attaches it. */
  async function attachUrlTo(
    course: Course,
    store: ResourceStore,
    target: AttachTarget,
    where: string,
  ): Promise<void> {
    const typed = await ui.askText({
      title:
        target.kind === 'course' ? 'Attach a URL to this Course' : 'Attach a URL to this Lesson',
      prompt: 'The address of a web page, to open in Simple Browser beside the code.',
      placeholder: 'https://…',
      validate: (text) => {
        const checked = checkWebUrl(text);
        return checked.ok ? undefined : checked.problem;
      },
    });
    if (typed === undefined) {
      return;
    }
    // The box checks as the learner types; the core does not rely on it (ADR 0047).
    const checked = checkWebUrl(typed);
    if (!checked.ok) {
      logger.log({ level: 'warn', message: `Not attaching a URL: ${checked.problem}` });
      ui.showMessage({
        severity: 'warning',
        text: `FollowAlong did not attach it. ${checked.problem}`,
      });
      return;
    }
    const made =
      target.kind === 'course'
        ? await store.attachUrlToCourse(checked.url)
        : await store.attachUrl(target.lessonId, checked.url);
    showResourceChange(course, store, {
      made,
      said: `attached “${urlLabel(checked.url)}” to ${where}`,
    });
  }

  /**
   * Opens a URL Resource in Simple Browser. The address is checked again here, not only when it was
   * attached: `resources.json` is a file on disk that anything could have written (ADR 0047).
   */
  async function openUrl(stored: string): Promise<void> {
    const checked = checkWebUrl(stored);
    if (!checked.ok) {
      logger.log({
        level: 'warn',
        message: `Not opening a URL Resource: ${checked.problem} (${stored.slice(0, 80)})`,
      });
      ui.showMessage({
        severity: 'warning',
        text: `FollowAlong did not open this Resource. ${checked.problem} Detach it in the Lesson tree.`,
      });
      return;
    }
    try {
      await ui.openResource({ kind: 'url', url: checked.url });
    } catch (error) {
      logger.log({
        level: 'warn',
        message: `Could not open ${checked.url}: ${messageOf(error)}`,
      });
      ui.showMessage({
        severity: 'error',
        text: `FollowAlong could not open “${urlLabel(checked.url)}” in Simple Browser.`,
      });
    }
  }

  return {
    async attachResource(lessonId, absolutePath) {
      const course = open.course();
      const store = open.store();
      if (course === undefined || store === undefined) {
        logger.log({ level: 'warn', message: `Cannot attach to ${lessonId}: no Course is open.` });
        return;
      }
      if (!lessonsInOrder(course).some((lesson) => lesson.id === lessonId)) {
        logger.log({
          level: 'warn',
          message: `Cannot attach to ${lessonId}: it is not a Lesson of the open Course.`,
        });
        return;
      }
      await attachTo(course, store, { kind: 'lesson', lessonId }, absolutePath);
    },
    async attachCourseResource(absolutePath) {
      // The Course and its store are fixed now, before the dialog opens (ADR 0024).
      const course = open.course();
      const store = open.store();
      if (course === undefined || store === undefined) {
        logger.log({ level: 'warn', message: 'Cannot attach to the Course: no Course is open.' });
        return;
      }
      if (lessonsInOrder(course).length === 0) {
        // Such a Course shows only its message, not a tree with a Course node to attach to.
        logger.log({ level: 'warn', message: 'Cannot attach to the Course: it has no Lessons.' });
        return;
      }
      await attachTo(course, store, { kind: 'course' }, absolutePath);
    },
    async attachToLoadedLesson() {
      // The Lesson is fixed when the learner presses the key, not when the dialog closes: the
      // learner means the Lesson they were watching, even if the next one starts meanwhile. Its
      // Course is fixed too, because another Course can hold a Lesson with the same id.
      // The Loaded Lesson is always one of the open Course's: `open` leaves it before switching.
      const lesson = open.loadedLesson();
      const course = open.course();
      const store = open.store();
      if (lesson === undefined || course === undefined || store === undefined) {
        ui.showMessage({
          severity: 'info',
          text: 'Open a Lesson first, then attach a Resource to it.',
        });
        return;
      }
      try {
        await attachTo(course, store, { kind: 'lesson', lessonId: lesson.id });
      } finally {
        // The dialog took keyboard focus: hand it back, also when the attach failed (ADR 0023).
        ui.returnFocus();
      }
    },
    async detachResource(resourceId) {
      const found = resourceOfOpenCourse(resourceId, 'detach');
      if (found === undefined) {
        return;
      }
      const { course, store, record } = found;
      const made = await store.detach(resourceId);
      showResourceChange(course, store, {
        made,
        said: `detached “${resourceName(course.folder, record)}”`,
      });
    },
    async relinkResource(resourceId, absolutePath) {
      const found = resourceOfOpenCourse(resourceId, 'relink');
      if (found === undefined) {
        return;
      }
      const { course, store, record } = found;
      if (record.kind === 'url') {
        // Relink points a Resource at another file; a URL has none (ADR 0047).
        logger.log({ level: 'info', message: `Not relinking ${resourceId}: it is a URL.` });
        ui.showMessage({
          severity: 'info',
          text: 'A URL can’t be relinked. Detach it and attach the new address instead.',
        });
        return;
      }
      const previousName = basename(resourcePath(course.folder, record));
      const path =
        absolutePath ??
        (await ui.pickFile({
          title: `Relink “${previousName}” to another file`,
          openLabel: 'Relink',
        }));
      if (path === undefined) {
        return;
      }
      const made = await store.relink(resourceId, path);
      showResourceChange(course, store, {
        made,
        said: `relinked “${previousName}” to “${basename(path)}”`,
      });
      if (!made && store.find(resourceId) === undefined) {
        // Another window detached it while the dialog was open: nothing is left to point anywhere.
        ui.showMessage({
          severity: 'info',
          text: `FollowAlong could not relink “${previousName}”: it is no longer one of the Resources of “${basename(course.folder)}”.`,
        });
      }
    },
    async openResource(resourceId) {
      const found = resourceOfOpenCourse(resourceId, 'open');
      if (found === undefined) {
        return;
      }
      const { course, store, record } = found;
      if (record.kind === 'url') {
        await openUrl(record.url);
        return;
      }
      const path = resourcePath(course.folder, record);
      // Looked at now, not when the Course opened: the file may have gone, or come back, since.
      if (await store.checkFiles()) {
        showResources(course, store);
      }
      if (store.missing().has(record.id)) {
        ui.showMessage({
          severity: 'warning',
          text: `FollowAlong can’t find “${basename(path)}”: it was moved, renamed or deleted. Use Relink… on it in the Lesson tree to point it at the file’s new place.`,
        });
        return;
      }
      try {
        await ui.openResource(resourceTarget(path));
      } catch (error) {
        logger.log({
          level: 'warn',
          message: `Could not open ${path}: ${messageOf(error)}`,
        });
        ui.showMessage({
          severity: 'error',
          text: `FollowAlong could not open “${basename(path)}”. Is the file still there?`,
        });
      }
    },
  };
}
