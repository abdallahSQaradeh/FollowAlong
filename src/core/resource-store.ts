/**
 * One open Course's Resources (spec #12, Core modules → Resource store; ADR 0012, ADR 0040): read
 * once when the Course opens, changed one change at a time (attach, detach, relink), and kept in
 * `resources.json` in the Course data (ADR 0005). It also knows which files are missing.
 */
import { basename } from 'node:path';

import { openCourseData, UnreadableCourseDataError, type CourseData } from './course-data.js';
import type { Ports } from './ports.js';
import {
  findResource,
  missingResources,
  newResource,
  noResources,
  resourcesFile,
  resourcesFileExists,
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
   * Looks again at where every Resource points. Resolves with whether the files found missing are
   * not the same as before.
   */
  checkFiles(): Promise<boolean>;
  /**
   * Each change resolves with whether it was made. It is not made when the Resources file cannot
   * be written (the learner has been told), or when it no longer applies (the Resource is gone).
   */
  attach(lessonId: string, absolutePath: string): Promise<boolean>;
  detach(resourceId: string): Promise<boolean>;
  /** Points the Resource at another file: it keeps its id and its place in its Lesson. */
  relink(resourceId: string, absolutePath: string): Promise<boolean>;
}

type ResourceStorePorts = Pick<Ports, 'fileSystem' | 'storage' | 'ui' | 'logger'>;

export async function openResources(
  folder: string,
  ports: ResourceStorePorts,
): Promise<ResourceStore> {
  const { fileSystem, ui, logger } = ports;
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
  /** Changes run one at a time, so two quick ones never overwrite each other. */
  let changing: Promise<unknown> = Promise.resolve();

  /** The Resources file is there but cannot be used: writing would replace what it holds. */
  function refuse(what: string): void {
    logger.log({
      level: 'warn',
      message: `Not ${what}: the Resources file of ${folder} is damaged or from a newer version, and was left as it is.`,
    });
    // The Course is named: after a switch, "this Course" would read as the one open now.
    ui.showMessage({
      severity: 'warning',
      text: `FollowAlong can't update the Resources file of “${basename(folder)}” (it is damaged or from a newer version). Nothing was changed.`,
    });
  }

  async function checkFiles(): Promise<boolean> {
    const found = await missingResources(fileSystem, folder, resources);
    const changed = found.size !== missing.size || [...found].some((id) => !missing.has(id));
    missing = found;
    return changed;
  }

  /**
   * Reads the file again (another window may have changed it since this Course opened), applies
   * `update` to what is there, and writes the result. `update` answers `undefined` when there is
   * nothing to change.
   */
  function change(
    what: string,
    update: (stored: ResourcesData) => ResourcesData | undefined,
  ): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const read = await data.read(resourcesFile);
      if (read === undefined && (await resourcesFileExists(fileSystem, folder))) {
        // The file is there but was ignored (damaged, or from a newer FollowAlong): writing
        // would replace data the learner, or a newer version, still needs.
        refuse(what);
        return false;
      }
      const stored = read ?? noResources;
      const next = update(stored);
      if (next === undefined) {
        resources = stored;
        await checkFiles();
        return false;
      }
      try {
        await data.write(resourcesFile, next);
      } catch (error) {
        // The copy the write would replace (the fallback one, in a read-only Course) is unusable.
        if (error instanceof UnreadableCourseDataError) {
          refuse(what);
          return false;
        }
        throw error;
      }
      resources = next;
      await checkFiles();
      return true;
    };
    const done = changing.then(run, run);
    changing = done.catch(() => undefined);
    return done;
  }

  return {
    current: () => resources,
    missing: () => missing,
    find: (resourceId) => findResource(resources, resourceId),
    checkFiles,
    async attach(lessonId, absolutePath) {
      const done = await change(`attaching ${absolutePath}`, (stored) =>
        withResource(stored, lessonId, newResource(folder, absolutePath)),
      );
      if (done) {
        logger.log({ level: 'info', message: `Attached ${absolutePath} to ${lessonId}` });
      }
      return done;
    },
    async detach(resourceId) {
      const done = await change(`detaching ${resourceId}`, (stored) =>
        withoutResource(stored, resourceId),
      );
      if (done) {
        logger.log({ level: 'info', message: `Detached ${resourceId}` });
      }
      return done;
    },
    async relink(resourceId, absolutePath) {
      const done = await change(`relinking ${resourceId} to ${absolutePath}`, (stored) =>
        withRelinkedResource(stored, resourceId, newResource(folder, absolutePath)),
      );
      if (done) {
        logger.log({ level: 'info', message: `Relinked ${resourceId} to ${absolutePath}` });
      }
      return done;
    },
  };
}
