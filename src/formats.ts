import { timedLine, type LyricDocument, type LyricLine, type LyricParseOptions, type TimedWord } from './timing.js';

const lineStamp = /^\[(\d{1,3}:\d{2}(?:\.\d{1,3})?)\]/;
const wordStamp = /<((?:\d{1,3}:)?\d{1,3}:\d{2}(?:\.\d{1,3})?)>/g;

export function parseStamp(value: string): number {
  const match = /^(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new Error('Invalid timestamp.');
  const withinMinute = Number(match[2]);
  if (withinMinute > 59) throw new Error('Timestamp seconds must be under one minute.');
  return Number(match[1]) * 60 + withinMinute + Number('0.' + (match[3] ?? '0'));
}

function fullStamp(value: string): number {
  const parts = value.split(':');
  if (parts.length === 2) return parseStamp(value);
  if (Number(parts[1]) > 59) throw new Error('Timestamp minutes must be under one hour.');
  return Number(parts[0]) * 3600 + parseStamp(parts[1] + ':' + parts[2]);
}

function enhancedWords(body: string, cueStart: number): { words: TimedWord[]; end?: number } {
  const tags = [...body.matchAll(wordStamp)];
  if (!tags.length) return { words: [] };
  const words: TimedWord[] = [];
  let previous = cueStart;
  const opening = body.slice(0, tags[0].index);
  if (opening.trim()) words.push({ text: opening, startSeconds: cueStart, endSeconds: cueStart });
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index];
    const seconds = fullStamp(tag[1]);
    if (seconds < previous) throw new Error('An enhanced LRC word timestamp is out of order.');
    if (words.length) words[words.length - 1].endSeconds = seconds;
    const text = body.slice(tag.index + tag[0].length, tags[index + 1]?.index);
    if (text) words.push({ text, startSeconds: seconds, endSeconds: seconds });
    previous = seconds;
  }
  return { words, end: body.endsWith(tags[tags.length - 1][0]) ? previous : undefined };
}

/** Parse LRC and Enhanced LRC cues, including repeated plain LRC timestamps. */
export function parseLrc(input: string, options: LyricParseOptions = {}): LyricDocument {
  const raw: { start: number; text: string; words: TimedWord[]; end?: number }[] = [];
  let title = '', artist = '';
  for (const source of input.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const metadata = /^\[(ti|ar):([^\]]*)\]$/i.exec(source.trim());
    if (metadata) {
      if (metadata[1].toLowerCase() === 'ti') title = metadata[2].trim();
      else artist = metadata[2].trim();
      continue;
    }
    let body = source.trimStart();
    const starts: number[] = [];
    for (let tag = lineStamp.exec(body); tag; tag = lineStamp.exec(body)) {
      starts.push(parseStamp(tag[1]));
      body = body.slice(tag[0].length);
    }
    if (!starts.length) continue;
    const { words, end } = enhancedWords(body.trimEnd(), starts[0]);
    const text = words.length ? words.map(word => word.text).join('') : body.trim();
    if (!text) continue;
    for (const start of starts) {
      const offset = start - starts[0];
      raw.push({
        start, text,
        words: words.map(word => ({ ...word, startSeconds: word.startSeconds + offset, endSeconds: word.endSeconds + offset })),
        end: end === undefined ? undefined : end + offset,
      });
    }
  }
  raw.sort((left, right) => left.start - right.start);
  const lines = raw.map((item, index) => {
    const next = raw[index + 1]?.start;
    const finalWord = item.words.at(-1);
    const inferred = next ?? Math.max(item.start + 2, (finalWord?.startSeconds ?? item.start) + 0.25);
    const end = Math.max(item.start, finalWord?.startSeconds ?? item.start, item.end ?? inferred);
    if (finalWord) finalWord.endSeconds = end;
    return timedLine(item.text, item.start, end, item.words, options);
  });
  return { title, artist, lines };
}

export function parseSrt(input: string, options: LyricParseOptions = {}): LyricLine[] {
  const blocks = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);
  const lines: LyricLine[] = [];
  for (const block of blocks) {
    const rows = block.split('\n');
    const time = rows.findIndex(row => row.includes('-->'));
    if (time < 0) continue;
    const match = /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[,.]\d{3})(?:\s.*)?$/.exec(rows[time].trim());
    if (!match) throw new Error('An SRT cue has an invalid time range.');
    const start = fullStamp(match[1].replace(',', '.')), end = fullStamp(match[2].replace(',', '.'));
    if (end < start) throw new Error('An SRT cue ends before it begins.');
    const text = rows.slice(time + 1).join('\n').replace(/<[^>]*>/g, '').trim();
    if (text) lines.push(timedLine(text, start, end, [], options));
  }
  return lines;
}

function units(seconds: number, perSecond: number): number {
  const normalized = Math.round(seconds * perSecond);
  if (!Number.isSafeInteger(normalized) || seconds < 0) throw new Error('A cue has an invalid timestamp.');
  return normalized;
}

function lrcTime(seconds: number): string {
  const centiseconds = units(seconds, 100);
  const minutes = Math.floor(centiseconds / 6000);
  if (minutes > 999) throw new Error('LRC timestamps are limited to 999 minutes.');
  return String(minutes).padStart(2, '0') + ':' + ((centiseconds % 6000) / 100).toFixed(2).padStart(5, '0');
}

function srtTime(seconds: number): string {
  const ms = units(seconds, 1000);
  const hours = Math.floor(ms / 3600000);
  if (hours > 99) throw new Error('SRT timestamps are limited to 99 hours.');
  const parts = [hours, Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60];
  return parts.map(part => String(part).padStart(2, '0')).join(':') + ',' + String(ms % 1000).padStart(3, '0');
}

const singleLine = (value: string) => value.replace(/\r?\n/g, ' ');

export function toLrc(title: string, artist: string, lines: readonly LyricLine[]): string {
  const metadata = [title, artist].map(value => singleLine(value).replace(/\]/g, ')'));
  const cues = lines.map(line => {
    const text = line.words.length
      ? line.words.map(word => '<' + lrcTime(word.startSeconds) + '>' + singleLine(word.text)).join('') + '<' + lrcTime(line.endSeconds) + '>'
      : singleLine(line.text);
    return '[' + lrcTime(line.startSeconds) + ']' + text;
  });
  return ['[ti:' + metadata[0] + ']', '[ar:' + metadata[1] + ']', ...cues].join('\n') + '\n';
}

export function toSrt(lines: readonly LyricLine[]): string {
  return lines.map((line, index) => {
    if (line.endSeconds < line.startSeconds) throw new Error('An SRT cue ends before it begins.');
    return (index + 1) + '\n' + srtTime(line.startSeconds) + ' --> ' + srtTime(line.endSeconds) + '\n' + line.text;
  }).join('\n\n') + (lines.length ? '\n' : '');
}
