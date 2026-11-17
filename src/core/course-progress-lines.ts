/**
 * The Progress line of a Course in the Course picker (spec #12, story 8): `27/140 · 19% · last:
 * <Lesson title>`, read from the Course's own Progress. It only reads: a Course is never written
 * to, and a Progress file that cannot be read gives no line (spec #12, D5).
 */
import { messageOf } from './logger.js';
import { openCourseData } from './course-data.js';
import { lessonsInOrder } from './course-model.js';
import { keyOf } from './folder-identity.js';
import { readCourse } from './folder-listing.js';
import { summaryOf, totalsOf } from './lesson-tree.js';
import { lessonStatus, noLastLesson, progressFile } from './progress.js';
import { FileSystemError, type Ports } from './ports.js';

type LinePorts = Pick<Ports, 'fileSystem' | 'storage' | 'logger'>;

/** How many Courses are read at the same time: hundreds of Courses are not opened all at once. */
const readAtOnce = 8;

/**
 * The Progress line of the Course in `folder`, or `undefined` when it has none to show: nothing
 * played yet, Progress reset, no Lessons, or a Progress file or folder that cannot be read. The
 * Progress is the newest per Lesson of the Course's own file and the fallback storage (D5), and
 * the numbers and the Lesson title are the ones the Lesson tree shows.
 */
export async function progressLineOf(
  ports: LinePorts,
  folder: string,
  roots: readonly string[],
): Promise<string | undefined> {
  const progress = await openCourseData(folder, ports).read(progressFile);
  // Looked at before the Course's folders are: most Courses under the roots have not been played.
  if (
    progress === undefined ||
    !Object.values(progress.lessons).some((l) => l.status !== undefined)
  ) {
    return undefined;
  }
  let course;
  try {
    course = await readCourse(ports, folder, roots);
  } catch (error) {
    if (error instanceof FileSystemError) {
      return undefined;
    }
    throw error;
  }
  const lessons = lessonsInOrder(course);
  if (!lessons.some((lesson) => lessonStatus(progress, lesson.id) !== 'notStarted')) {
    return undefined;
  }
  const summary = summaryOf(totalsOf(course, progress));
  const lastId = progress.last?.lessonId ?? noLastLesson;
  const last = lastId === noLastLesson ? undefined : lessons.find((lesson) => lesson.id === lastId);
  return last === undefined ? summary.description : `${summary.description} · last: ${last.title}`;
}

/**
 * The Progress lines of these Course folders, by {@link keyOf} the folder (`undefined` for a Course
 * with none), under the Courses `roots`. `cancelled` stops the reading early, between batches.
 */
export async function readProgressLines(
  ports: LinePorts,
  folders: readonly string[],
  roots: readonly string[],
  cancelled: () => boolean,
): Promise<Map<string, string | undefined>> {
  const lines = new Map<string, string | undefined>();
  for (let start = 0; start < folders.length && !cancelled(); start += readAtOnce) {
    await Promise.all(
      folders.slice(start, start + readAtOnce).map(async (folder) => {
        try {
          lines.set(keyOf(folder), await progressLineOf(ports, folder, roots));
        } catch (error) {
          // Not read: an older line must not stay up for a Progress that cannot be read now.
          lines.set(keyOf(folder), undefined);
          ports.logger.log({
            level: 'error',
            message: `Could not read the Progress of ${folder}: ${messageOf(error)}`,
          });
        }
      }),
    );
  }
  return lines;
}
