// A CSV reader. Pure: text in, records out, touches no file and knows nothing about stock.
// The dialect is RFC 4180: fields separated by commas, a field may be wrapped in double quotes,
// and inside quotes a comma or a line break is part of the field and "" is one quote character.

// Splits CSV text into records, in file order: [{ line, fields, raw, problem }].
//   line     the line of the text the record starts on, counting from 1
//   fields   the field values, quotes removed, otherwise exactly as written (not trimmed)
//   raw      the record's own text, without its line end
//   problem  undefined, or why the record's quoting cannot be trusted
// A record with a problem is still returned, so that one bad row never hides the rows after it.
// Lines holding only spaces are passed over. A byte-order mark is accepted. A line ends with
// LF, CR LF or CR. Only a quote that is never closed cannot be recovered from: everything from
// that record to the end of the text is then one record, with a problem.
export function parseCsv(input) {
  const text = input.replace(/^﻿/, '');
  const records = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const start = i;
    const startLine = line;
    const fields = [];
    let field = '';
    let problem;
    let quoteLine;
    let state = 'start';   // start (of a field) | plain | quoted | closed (just after a closing quote)
    while (i < text.length) {
      const c = text[i];
      if (state === 'quoted') {
        if (c === '"' && text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (c === '"') {
          state = 'closed';
          i += 1;
        } else {
          if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line += 1;
          field += c;
          i += 1;
        }
      } else if (c === '\n' || c === '\r') {
        break;
      } else if (c === ',') {
        fields.push(field);
        field = '';
        state = 'start';
        i += 1;
      } else if (c === '"' && state === 'start') {
        state = 'quoted';
        quoteLine = line;
        i += 1;
      } else {
        if (state === 'closed') problem ??= 'there is text after a closing quote; a quote inside a quoted field is written twice ("")';
        else if (c === '"') problem ??= 'there is a quote inside a field that is not quoted; put the whole field in quotes and write the quote twice ("")';
        field += c;
        state = 'plain';
        i += 1;
      }
    }
    if (state === 'quoted') {
      problem = `the quote opened on line ${quoteLine} is never closed, so nothing from there to the end of the file could be read`;
    }
    fields.push(field);
    const raw = text.slice(start, i);
    if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else if (i < text.length) i += 1;
    line += 1;
    if (raw.trim() !== '') records.push({ line: startLine, fields, raw, problem });
  }
  return records;
}
