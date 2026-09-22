// An error a route can show to the user as-is. `status` is the HTTP status and
// `userMessage` the text the UI displays; `message` keeps the technical detail for the
// server log. withHandler (src/lib/api-handler.ts) turns it into the JSON response, so a
// domain module can decide what its failures mean to the user without every route
// repeating an instanceof ladder.
export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = 'UserFacingError';
  }
}
