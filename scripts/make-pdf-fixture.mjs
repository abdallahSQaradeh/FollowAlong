// @ts-check
/**
 * Regenerates the PDF fixtures in test/fixtures/pdf/ (spec #12, Testing Decisions: small generated
 * fixtures). The outputs are committed, so tests need nothing installed; run this only to change
 * them: node scripts/make-pdf-fixture.mjs
 *
 * - sample.pdf: 3 pages of 300 x 200 pt (PDF 1.4), each a line of text in the standard Helvetica
 *   font, so the viewer has pages to count and to draw.
 * - active.pdf: one page that is a link to https://example.invalid/ all over, in a file whose
 *   OpenAction runs JavaScript. The viewer must show the page and do neither (ADR 0021).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'fixtures', 'pdf');
mkdirSync(out, { recursive: true });

/**
 * @param {{ pages: number, catalog?: string, pageEntries?: string }} options
 * @returns {string} the file, one byte per character
 */
function makePdf({ pages, catalog = '', pageEntries = '' }) {
  /** @type {string[]} */
  const objects = [];
  // 1: catalog, 2: page tree, 3: font, then a page and its content stream per page.
  objects.push(`<< /Type /Catalog /Pages 2 0 R${catalog === '' ? '' : ` ${catalog}`} >>`);
  const kids = Array.from({ length: pages }, (_, index) => `${String(4 + index * 2)} 0 R`).join(
    ' ',
  );
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${String(pages)} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let index = 0; index < pages; index += 1) {
    const content = `BT /F1 24 Tf 40 100 Td (Page ${String(index + 1)} of ${String(pages)}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(5 + index * 2)} 0 R${pageEntries === '' ? '' : ` ${pageEntries}`} >>`,
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
  return body;
}

writeFileSync(join(out, 'sample.pdf'), makePdf({ pages: 3 }), 'latin1');
writeFileSync(
  join(out, 'active.pdf'),
  makePdf({
    pages: 1,
    catalog: '/OpenAction << /S /JavaScript /JS (app.alert\\("ran"\\)) >>',
    pageEntries:
      '/Annots [ << /Type /Annot /Subtype /Link /Rect [0 0 300 200] /Border [0 0 0] /A << /S /URI /URI (https://example.invalid/) >> >> ]',
  }),
  'latin1',
);
console.log('make-pdf-fixture: wrote test/fixtures/pdf/sample.pdf and active.pdf');
