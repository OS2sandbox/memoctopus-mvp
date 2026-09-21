// Errors the minutes generator throws instead of returning a truncated or partial referat.
// Kept apart from minutes.ts so the route (and its tests, which mock minutes.ts) can use
// `instanceof` without depending on the generator module.

/** The configured context window leaves too little room for a transcript. Operator problem. */
export class MinutesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MinutesConfigError';
  }
}

/** A call ended with finish_reason "length": the model ran out of output tokens. */
export class MinutesTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MinutesTruncatedError';
  }
}

/** Even after repeated summarising, the text does not fit the context budget. */
export class MinutesTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MinutesTooLongError';
  }
}
