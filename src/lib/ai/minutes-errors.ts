import { UserFacingError } from '@/lib/user-facing-error';

// Errors the minutes generator throws instead of returning a truncated or partial referat.
// Each carries the status and Danish message the user sees (see UserFacingError); the
// technical detail in `message` goes to the server log.

/** The configured context window leaves too little room for a transcript. Operator problem. */
export class MinutesConfigError extends UserFacingError {
  constructor(message: string) {
    super(
      message,
      500,
      'AI-modellens indstillinger tillader ikke at generere et referat. Kontakt administratoren.',
    );
    this.name = 'MinutesConfigError';
  }
}

/** The final referat call ended with finish_reason "length": the model ran out of output tokens. */
export class MinutesTruncatedError extends UserFacingError {
  constructor(message: string) {
    super(
      message,
      422,
      'Referatet blev ikke færdigt, fordi AI-modellens svargrænse blev nået. Prøv igen med en kortere skabelon, eller kontakt administratoren.',
    );
    this.name = 'MinutesTruncatedError';
  }
}

/** Even after repeated summarising, the text does not fit the context budget. */
export class MinutesTooLongError extends UserFacingError {
  constructor(message: string) {
    super(
      message,
      422,
      'Mødet er for langt til at blive opsummeret med den nuværende AI-model. Kontakt administratoren.',
    );
    this.name = 'MinutesTooLongError';
  }
}
