import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv } from '../src/csv.js';

const fields = (text) => parseCsv(text).map((record) => record.fields);

test('plain fields are split on commas, one record per line', () => {
  assert.deepEqual(parseCsv('item,type,quantity\nwidget,in,10\n'), [
    { line: 1, fields: ['item', 'type', 'quantity'], raw: 'item,type,quantity', problem: undefined },
    { line: 2, fields: ['widget', 'in', '10'], raw: 'widget,in,10', problem: undefined },
  ]);
});

test('LF, CR LF and CR all end a line, and the last line needs no line end', () => {
  for (const end of ['\n', '\r\n', '\r']) {
    assert.deepEqual(fields(`a,b${end}c,d${end}`), [['a', 'b'], ['c', 'd']], JSON.stringify(end));
    assert.deepEqual(fields(`a,b${end}c,d`), [['a', 'b'], ['c', 'd']], `${JSON.stringify(end)} with no final line end`);
    assert.deepEqual(parseCsv(`a${end}b${end}c`).map((r) => r.line), [1, 2, 3], JSON.stringify(end));
  }
});

test('fields are not trimmed and empty fields are kept', () => {
  assert.deepEqual(fields(' a , b,,\n,\n'), [[' a ', ' b', '', ''], ['', '']]);
});

test('a quoted field may hold commas, doubled quotes and line breaks', () => {
  assert.deepEqual(fields('"blue, widget",in,5\n'), [['blue, widget', 'in', '5']]);
  assert.deepEqual(fields('"6"" nail",in,5\n'), [['6" nail', 'in', '5']]);
  assert.deepEqual(fields('"",in,""\n'), [['', 'in', '']]);
  assert.deepEqual(fields('""""\n'), [['"']]);
  const [first, second] = parseCsv('"two\r\nlines",in,5\nbolt,in,1\n');
  assert.deepEqual(first.fields, ['two\r\nlines', 'in', '5']);
  assert.equal(first.raw, '"two\r\nlines",in,5');
  assert.equal(first.problem, undefined);
  assert.deepEqual([first.line, second.line], [1, 3], 'a line break inside quotes still counts as a line');
});

test('a byte-order mark is dropped and lines holding only spaces are passed over, keeping line numbers', () => {
  const records = parseCsv('﻿item,type,quantity\r\n\r\n   \r\nwidget,in,1\r\n\r\n');
  assert.deepEqual(records.map((r) => [r.line, r.fields]), [[1, ['item', 'type', 'quantity']], [4, ['widget', 'in', '1']]]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('\n\n  \n'), []);
});

test('bad quoting marks that record only; the records after it are read as usual', () => {
  const records = parseCsv('a,b\nwid"get,in,5\n"wid"get,in,5\n"widget" ,in,5\n w"x",in,5\nbolt,in,1\n');
  assert.deepEqual(records.map((r) => r.problem === undefined), [true, false, false, false, false, true]);
  assert.match(records[1].problem, /quote inside a field that is not quoted/);
  assert.match(records[2].problem, /text after a closing quote/);
  assert.match(records[3].problem, /text after a closing quote/);
  assert.deepEqual(records[5], { line: 6, fields: ['bolt', 'in', '1'], raw: 'bolt,in,1', problem: undefined });
  assert.deepEqual(records.map((r) => r.raw), ['a,b', 'wid"get,in,5', '"wid"get,in,5', '"widget" ,in,5', ' w"x",in,5', 'bolt,in,1']);
});

test('a quote that is never closed takes the rest of the text as one record with a problem; records before it stand', () => {
  const records = parseCsv('a,b\nwidget,in,1\nbolt,"in,2\nnut,in,3\ngadget,in,4\n');
  assert.equal(records.length, 3);
  assert.deepEqual(records[1], { line: 2, fields: ['widget', 'in', '1'], raw: 'widget,in,1', problem: undefined });
  assert.equal(records[2].line, 3);
  assert.equal(records[2].raw, 'bolt,"in,2\nnut,in,3\ngadget,in,4\n');
  assert.match(records[2].problem, /quote opened on line 3 is never closed/);
});

test('the quote line in the problem is the line the quote opened on, not the line the record started on', () => {
  const [record] = parseCsv('"a\nb","c\nd');
  assert.match(record.problem, /quote opened on line 2 is never closed/);
});

test('other separators are not guessed at: a semicolon or a tab is part of the field', () => {
  assert.deepEqual(fields('item;type;quantity\na\tb\n'), [['item;type;quantity'], ['a\tb']]);
});
