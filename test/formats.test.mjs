import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLrc, parseSrt, parseStamp, toLrc, toSrt } from '@thepropervolume/karaoke-core';

test('preserves Enhanced LRC lyric phrases, metadata, start times and the terminal marker', () => {
  const opening = '[ti:Evening Test]\n[ar:TPV]\n[00:02.00]<00:02.00>Night <00:02.70>sky<00:04.20>\n';
  const { title, artist, lines } = parseLrc(opening, { makeId: () => 'cue-1' });
  assert.equal(title, 'Evening Test');
  assert.equal(artist, 'TPV');
  assert.deepEqual(lines[0], {
    id: 'cue-1',
    text: 'Night sky',
    startSeconds: 2,
    endSeconds: 4.2,
    words: [
      { text: 'Night ', startSeconds: 2, endSeconds: 2.7 },
      { text: 'sky', startSeconds: 2.7, endSeconds: 4.2 },
    ],
  });
  assert.equal(toLrc(title, artist, lines), opening);
});

test('sorts repeated LRC lyrics by start and preserves increasing word ranges', () => {
  const { lines } = parseLrc('[02:50.30][00:03.00]<02:50.30>Again<02:51.00>\n[00:14.00]Next');
  assert.deepEqual(lines.map(line => line.text), ['Again', 'Next', 'Again']);
  assert.deepEqual(lines.map(line => line.startSeconds), [3, 14, 170.3]);
  assert.ok(lines[0].words[0].endSeconds > lines[0].words[0].startSeconds);
  assert.ok(lines[2].words[0].endSeconds > lines[2].words[0].startSeconds);
});

test('reads SRT long timestamps, custom IDs and multiline lyrics', () => {
  const lines = parseSrt('\uFEFF1\r\n01:00:01,250 --> 01:00:02,500\r\n<i>One line</i>\r\nAnd two\r\n', { makeId: () => 'id' });
  assert.equal(lines[0].id, 'id');
  assert.equal(lines[0].startSeconds, 3601.25);
  assert.equal(lines[0].endSeconds, 3602.5);
  assert.deepEqual(lines[0].words, []);
  assert.equal(toSrt(lines), '1\n01:00:01,250 --> 01:00:02,500\nOne line\nAnd two\n');
});

test('rejects invalid and out-of-order time values', () => {
  assert.throws(() => parseStamp('1:99'), /under one minute/);
  assert.throws(() => parseSrt('1\n00:60:01,250 --> 01:00:02,500\nInvalid'), /under one hour/);
  assert.throws(() => parseSrt('1\n00:00:02,250 --> 00:00:01,250\nInvalid'), /ends before/);
  assert.throws(() => parseLrc('[00:10.00]<00:11.25>First <00:11.00>second'), /out of order/);
  assert.throws(() => toSrt([{ startSeconds: 0, endSeconds: NaN, text: 'Invalid' }]), /invalid timestamp/);
});
