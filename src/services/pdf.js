import zlib from 'node:zlib';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

// PDF name tokens that enable scripts, launching programs, embedded payloads or form submission.
const DANGEROUS_RE =
  /\/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia|XFA|SubmitForm|ImportData|GoToE|Sound|Movie)(?![A-Za-z0-9])/;
const ENCRYPT_RE = /\/Encrypt(?![A-Za-z0-9])/;
const PAGE_RE = /\/Type\s*\/Page(?![A-Za-z0-9])/g;

const MAX_STREAMS = 10_000;
const MAX_STREAM_INFLATED = 32 * 1024 * 1024;
const MAX_TOTAL_INFLATED = 128 * 1024 * 1024;

/** Undo `#xx` hex escapes in names, e.g. `/J#61vaScript` -> `/JavaScript`. */
const decodeNameEscapes = (text) => text.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

const reject = (message) => new HttpError(422, 'unsafe_pdf', message);

/**
 * Splits the PDF into "structure" text (everything outside stream data) and the decompressed
 * content of FlateDecode streams. Raw stream bytes are never pattern-matched: compressed data is
 * effectively random and would produce false positives. Object streams (PDF 1.5+) hide
 * dictionaries in compressed form, so they are inflated and inspected as well.
 */
function* segments(buf) {
  let pos = 0;
  let count = 0;
  let total = 0;
  while (true) {
    const start = buf.indexOf('stream', pos, 'latin1');
    if (start === -1) break;
    let dataStart = start + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] !== 0x0a || buf.toString('latin1', start - 3, start) === 'end') {
      yield buf.toString('latin1', pos, start + 6);
      pos = start + 6;
      continue;
    }
    dataStart++;
    const end = buf.indexOf('endstream', dataStart, 'latin1');
    if (end === -1) throw reject('PDF is truncated or malformed');
    if (++count > MAX_STREAMS) throw reject('PDF has too many streams to verify');

    const structure = buf.toString('latin1', pos, start);
    yield structure;
    pos = end;

    const dictStart = structure.lastIndexOf('<<');
    const header = decodeNameEscapes(dictStart === -1 ? structure.slice(-1024) : structure.slice(dictStart));
    if (!/\/FlateDecode/.test(header) || /\/Subtype\s*\/Image/.test(header)) continue;

    const isObjectStream = /\/Type\s*\/ObjStm/.test(header);
    let out;
    try {
      out = zlib.inflateSync(buf.subarray(dataStart, end), {
        maxOutputLength: Math.max(1, Math.min(MAX_STREAM_INFLATED, MAX_TOTAL_INFLATED - total)),
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
      });
    } catch {
      // An object stream we cannot fully inspect could be hiding anything.
      if (isObjectStream) throw reject('PDF contains an object stream that cannot be verified');
      if (total >= MAX_TOTAL_INFLATED) throw reject('PDF is too complex to verify');
      continue;
    }
    total += out.length;
    yield out.toString('latin1');
  }
  yield buf.toString('latin1', pos);
}

/**
 * Structural safety check for PDFs. Rejects documents with active content (JavaScript, launch
 * actions, embedded files, XFA forms, ...) and, by default, encrypted documents whose content
 * cannot be inspected. Returns an approximate page count.
 */
export function inspectPdf(buffer) {
  if (!buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw reject('Not a valid PDF file');
  if (buffer.lastIndexOf('%%EOF', undefined, 'latin1') === -1) throw reject('PDF is truncated or malformed');

  let pages = 0;
  for (const chunk of segments(buffer)) {
    const text = decodeNameEscapes(chunk);
    if (!config.pdfAllowEncrypted && ENCRYPT_RE.test(text)) throw reject('Encrypted PDFs are not accepted');
    if (config.pdfBlockActiveContent) {
      const found = text.match(DANGEROUS_RE);
      if (found) throw reject(`PDF contains disallowed active content (${found[1]})`);
    }
    pages += (text.match(PAGE_RE) || []).length;
  }
  return { pages: pages || null };
}
