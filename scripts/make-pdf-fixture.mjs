// @ts-check
/**
 * Regenerates test/fixtures/pdf/sample.pdf (spec #12, Testing Decisions: small generated
 * fixtures). The output is committed, so tests need nothing installed; run this only to change it:
 * node scripts/make-pdf-fixture.mjs
 *
 * The file is a 3-page PDF 1.4, A5 landscape-ish (300 x 200 pt), each page a line of text in the
 * standard Helvetica font, so the viewer has pages to count and to draw.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'fixtures', 'pdf');
mkdirSync(out, { recursive: true });

const pages = 3;
/** @type {string[]} */
const objects = [];
// 1: catalog, 2: page tree, 3: font, then a page and its content stream per page.
objects.push('<< /Type /Catalog /Pages 2 0 R >>');
const kids = Array.from({ length: pages }, (_, index) => `${String(4 + index * 2)} 0 R`).join(' ');
objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${String(pages)} >>`);
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
for (let index = 0; index < pages; index += 1) {
  const content = `BT /F1 24 Tf 40 100 Td (Page ${String(index + 1)} of ${String(pages)}) Tj ET`;
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(5 + index * 2)} 0 R >>`,
  );
  objects.push(`<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`);
}

let body = '%PDF-1.4\n';
/** @type {number[]} */
const offsets = [];
objects.forEach((object, index) => {
  offsets.push(body.length);
  body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
});
const xref = body.length;
body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
for (const offset of offsets) {
  body += `${String(offset).padStart(10, '0')} 00000 n \n`;
}
body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
writeFileSync(join(out, 'sample.pdf'), body, 'latin1');
console.log(`make-pdf-fixture: wrote test/fixtures/pdf/sample.pdf (${String(pages)} pages)`);
