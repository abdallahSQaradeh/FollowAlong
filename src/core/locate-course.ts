/**
 * Locate… (spec #12, story 19; ADR 0042): a Recent Course whose folder moved is pointed at its new
 * folder, and keeps its Course data. A writable Course keeps its Progress and Resources in its own
 * `.followalong`, which moved with it. A read-only Course keeps them in the extension storage,
 * keyed by its old absolute path (ADR 0005), so they are carried to the new folder's key.
 */
import { basename } from 'node:path';

import { messageOf } from './logger.js';
import { openCourseData, type CourseData, type CourseDataFile } from './course-data.js';
import { lessonsInOrder } from './course-model.js';
import { normalisedRoot } from './courses-roots.js';
import { folderLabel } from './course-scanner.js';
import { readCourse } from './folder-listing.js';
import { FileSystemError, type Ports } from './ports.js';
import { progressFile } from './progress.js';
import { relocateRecent } from './recent-courses.js';
import { resourcesFile } from './resources.js';

type LocatePorts = Pick<Ports, 'fileSystem' | 'storage' | 'logger' | 'ui'>;

/**
 * Asks for the new folder of the Recent Course at `folder`, and points it there. Resolves with
 * whether it did: not when the learner cancels, when the new folder holds no Lessons, or when its
 * Course data could not be carried over; the entry then stays as it was.
 */
export async function locateCourse(
  ports: LocatePorts,
  folder: string,
  roots: readonly string[],
): Promise<boolean> {
  const { ui, storage, logger } = ports;
  const chosen = await ui.chooseFolder({
    title: `Locate “${folderLabel(folder)}”`,
    openLabel: 'Locate',
  });
  const located = chosen === undefined ? undefined : normalisedRoot(chosen);
  if (located === undefined) {
    return false;
  }
  if (!(await holdsLessons(ports, located, roots))) {
    ui.showMessage({
      severity: 'warning',
      text: `FollowAlong found no Lessons (.mp4 or .webm) in “${basename(located)}”, so “${folderLabel(folder)}” still points to its old folder.`,
    });
    return false;
  }
  try {
    const from = openCourseData(folder, ports);
    const to = openCourseData(located, ports);
    await carry(ports, progressFile, from, to, located);
    await carry(ports, resourcesFile, from, to, located);
  } catch (error) {
    logger.log({
      level: 'error',
      message: `Could not carry the Course data of ${folder} to ${located}: ${messageOf(error)}`,
    });
    ui.showMessage({
      severity: 'error',
      text: `FollowAlong could not carry the progress of “${folderLabel(folder)}” to “${basename(located)}”, so it still points to its old folder. Nothing was changed.`,
    });
    return false;
  }
  await relocateRecent(storage.global, folder, located);
  logger.log({ level: 'info', message: `Located ${folder} at ${located}` });
  return true;
}

/** Whether the folder holds a Lesson at any depth, as the Course model reads it. */
async function holdsLessons(
  ports: LocatePorts,
  folder: string,
  roots: readonly string[],
): Promise<boolean> {
  try {
    return lessonsInOrder(await readCourse(ports, folder, roots)).length > 0;
  } catch (error) {
    if (error instanceof FileSystemError) {
      return false;
    }
    throw error;
  }
}

/**
 * Carries one file of Course data from the old folder's store to the new one's. What the new
 * folder already has is merged in when the file can be merged, and is left as it is when not: a
 * file FollowAlong cannot read is never written over (D5), and the store sends the data to the
 * extension storage then.
 */
async function carry<T>(
  ports: LocatePorts,
  file: CourseDataFile<T>,
  from: CourseData,
  to: CourseData,
  located: string,
): Promise<void> {
  const carried = await from.read(file);
  if (carried === undefined) {
    return;
  }
  const existing = await to.read(file);
  if (existing === undefined) {
    await to.write(file, carried);
  } else if (file.merge === undefined) {
    ports.logger.log({
      level: 'info',
      message: `${located} already has ${file.name}: keeping it, not carrying the old copy over it.`,
    });
  } else {
    await to.write(file, file.merge(existing, carried));
  }
}
