/**
 * One open Course's Resources (spec #12, Core modules → Resource store; ADR 0012, ADR 0040): read
 * once when the Course opens, changed one change at a time (attach, detach, relink), and kept in
 * `resources.json` in the Course data (ADR 0005). It also knows which files are missing.
 */
import { basename } from 'node:path';

import {
  openCourseData,
  UnreadableCourseDataError,
  type CourseData,
  type CourseDataWritten,
} from './course-data.js';
import type { Ports } from './ports.js';
import {
  findResource,
  missingResources,
  newResource,
  newUrlResource,
  noResources,
  resourcesFile,
  withCourseResource,
  withRelinkedResource,
  withoutResource,
  withResource,
  type ResourceRecord,
  type ResourcesData,
} from './resources.js';

export interface ResourceStore {
  /** What is attached now, as the last read or change left it. */
  current(): ResourcesData;
  /** The ids of the Resources whose file is not where they point, as the last look found them. */
  missing(): ReadonlySet<string>;
  find(resourceId: string): ResourceRecord | undefined;
  /**
   * Looks again at where every Resource points, after any change under way. Resolves with whether
   * the files found missing are not the same as before.
   */
  checkFiles(): Promise<boolean>;
  /**
   * Each change resolves with whether it was made. It is not made when the Resources file cannot
   * be written (the learner has been told), or when it no longer applies (the Resource is gone).
   */
  attach(lessonId: string, absolutePath: string): Promise<boolean>;
  /** Attaches a file to the whole Course. */
  attachToCourse(absolutePath: string): Promise<boolean>;
  /** Attaches a web page, already checked with `checkWebUrl`, to a Lesson. */
  attachUrl(lessonId: string, url: string): Promise<boolean>;
  /** Attaches a web page, already checked with `checkWebUrl`, to the whole Course. */
  attachUrlToCourse(url: string): Promise<boolean>;
  detach(resourceId: string): Promise<boolean>;
  /** Points the Resource at another file: it keeps its id and its place in its Lesson. */
  relink(resourceId: string, absolutePath: string): Promise<boolean>;
}

type ResourceStorePorts = Pick<Ports, 'fileSystem' | 'storage' | 'clock' | 'ui' | 'logger'>;

export async function openResources(
  folder: string,
  ports: ResourceStorePorts,
): Promise<ResourceStore> {
  const { fileSystem, clock, ui, logger } = ports;
  const data: CourseData = openCourseData(folder, ports);
  let resources: ResourcesData = noResources;
  try {
    // A Course whose file cannot be read still opens, without Resources: the Lessons still play.
    resources = (await data.read(resourcesFile)) ?? noResources;
  } catch (error) {
    logger.log({
      level: 'warn',
      message: `Could not read the Resources of ${folder}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  let missing: ReadonlySet<string> = await missingResources(fileSystem, folder, resources);
  /** The learner is told once per open Course that its Resources went to the extension storage. */
  let keptElsewhereShown = false;
  /** Changes and looks at the files run one at a time, so none overwrites what another found. */
  let turn: Promise<unknown> = Promise.resolve();

  /** Neither copy of the Resources file can be used: writing would replace what it holds. */
  function refuse(action: string): void {
    logger.log({
      level: 'warn',
      message: `Not ${action}: the Resources file of ${folder} is damaged or from a newer version, and was left as it is.`,
    });
    // The Course is named: after a switch, "this Course" would read as the one open now.
    ui.showMessage({
      severity: 'warning',
      text: `FollowAlong can't update the Resources file of “${basename(folder)}” (it is damaged or from a newer version). Nothing was changed.`,
    });
  }

  /** Runs `work` after the one before it, so changes and looks at the files never overlap. */
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const done = turn.then(work, work);
    turn = done.catch(() => undefined);
    return done;
  }

  /** Looks at every file now; the caller is the one in turn. */
  async function lookAtFiles(): Promise<boolean> {
    const found = await missingResources(fileSystem, folder, resources);
    const changed = found.size !== missing.size || [...found].some((id) => !missing.has(id));
    missing = found;
    return changed;
  }

  /**
   * Reads the file again (another window may have changed it since this Course opened), applies
   * `update` to what is there, and writes the result. `update` answers `undefined` when there is
   * nothing to change. Resolves with whether the change was made; `done` is logged when it was.
   */
  function change(
    action: string,
    done: string,
    update: (stored: ResourcesData) => ResourcesData | undefined,
  ): Promise<boolean> {
    return inTurn(async () => {
      const stored = (await data.read(resourcesFile)) ?? noResources;
      const next = update(stored);
      if (next === undefined) {
        // What is stored is what is there now, whatever this session showed until now.
        resources = stored;
        await lookAtFiles();
        return false;
      }
      let written: CourseDataWritten<ResourcesData>;
      try {
        written = await data.write(resourcesFile, next);
      } catch (error) {
        // Both copies are unusable: neither is replaced (spec #12, D5), and nothing is changed.
        if (error instanceof UnreadableCourseDataError) {
          refuse(action);
          return false;
        }
        throw error;
      }
      // A copy that could not be read before could be now: what it held is in the file written.
      resources = written.merged ?? next;
      if (written.keptElsewhere !== undefined && !keptElsewhereShown) {
        keptElsewhereShown = true;
        logger.log({
          level: 'warn',
          message: `${written.keptElsewhere} cannot be read: keeping the Resources of ${folder} in the extension storage.`,
        });
        ui.showMessage({
          severity: 'warning',
          text: `FollowAlong can't update the Resources file of “${basename(folder)}” (it is damaged, unreadable or from a newer FollowAlong), so FollowAlong keeps its Resources in its own storage for now.`,
        });
      }
      await lookAtFiles();
      logger.log({ level: 'info', message: done });
      return true;
    });
  }

  return {
    current: () => resources,
    missing: () => missing,
    find: (resourceId) => findResource(resources, resourceId),
    checkFiles: () => inTurn(lookAtFiles),
    attach: (lessonId, absolutePath) =>
      change(`attaching ${absolutePath}`, `Attached ${absolutePath} to ${lessonId}`, (stored) =>
        withResource(stored, lessonId, newResource(folder, absolutePath)),
      ),
    attachToCourse: (absolutePath) =>
      change(`attaching ${absolutePath}`, `Attached ${absolutePath} to the Course`, (stored) =>
        withCourseResource(stored, newResource(folder, absolutePath)),
      ),
    attachUrl: (lessonId, url) =>
      change(`attaching ${url}`, `Attached ${url} to ${lessonId}`, (stored) =>
        withResource(stored, lessonId, newUrlResource(url)),
      ),
    attachUrlToCourse: (url) =>
      change(`attaching ${url}`, `Attached ${url} to the Course`, (stored) =>
        withCourseResource(stored, newUrlResource(url)),
      ),
    detach: (resourceId) =>
      change(`detaching ${resourceId}`, `Detached ${resourceId}`, (stored) =>
        withoutResource(stored, resourceId, clock.now()),
      ),
    relink: (resourceId, absolutePath) =>
      change(
        `relinking ${resourceId} to ${absolutePath}`,
        `Relinked ${resourceId} to ${absolutePath}`,
        (stored) =>
          withRelinkedResource(stored, resourceId, newResource(folder, absolutePath), clock.now()),
      ),
  };
}
