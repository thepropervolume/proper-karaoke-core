/** Word timing in seconds with the original spacing retained in text. */
export type TimedWord = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type LyricLine = {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  words: TimedWord[];
};

export type LyricDocument = {
  title: string;
  artist: string;
  lines: LyricLine[];
};

export type LyricParseOptions = {
  /** Keep stable IDs when integrating with a caller's own identity store. */
  makeId?: () => string;
};

export function timedLine(
  text: string,
  startSeconds: number,
  endSeconds: number,
  words: TimedWord[],
  options: LyricParseOptions,
): LyricLine {
  return { id: options.makeId?.() ?? crypto.randomUUID(), text, startSeconds, endSeconds, words };
}
