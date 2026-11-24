// @ts-check
/**
 * PROTOTYPE, throwaway (ticket "How does a YouTube Lesson feel in the player?"). Never merge.
 *
 * Makes a Course folder of YouTube stand-in Lessons: one `NN Title.youtube.webm` text file per
 * URL, holding the URL. The spike's player panel plays such a file through the YouTube relay.
 *
 * Usage: npm run prototype:youtube-course -- <course folder> <YouTube URL or ID>...
 * With no URLs it writes three embeddable videos.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [folder, ...urls] = process.argv.slice(2);
if (folder === undefined) {
  console.log('Usage: npm run prototype:youtube-course -- <course folder> <YouTube URL or ID>...');
  process.exit(1);
}
const lessons =
  urls.length > 0
    ? urls
    : [
        'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        'https://www.youtube.com/watch?v=YE7VzlLtp-4',
      ];
mkdirSync(folder, { recursive: true });
lessons.forEach((url, index) => {
  const number = String(index + 1);
  const name = `${number.padStart(2, '0')} YouTube Lesson ${number}.youtube.webm`;
  writeFileSync(join(folder, name), `${url}\n`);
  console.log(`${name}  →  ${url}`);
});
