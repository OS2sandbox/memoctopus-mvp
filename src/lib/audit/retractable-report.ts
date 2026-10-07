/**
 * The "report first, retract if it did not happen" skeleton of the client-reported delete events
 * (meeting.delete, meeting.audio_delete), see reportAuditEvent in ./client.
 *
 * `early` (an automatic delete, which may run from the tab-close purge where a frozen page never
 * reaches a later step): `report` runs BEFORE anything is awaited and its retract function is kept.
 * `work` gets a `retractIfMissing` callback to call as soon as it knows nothing existed, and
 * resolves to whether something was deleted. The report is retracted when the work throws.
 * Not early (the person asked): nothing is reported unless the work resolves to true, then it is
 * reported once, after the delete went through. A retract only undoes an event that has not been
 * delivered yet (about a second); after that the event stays, which is accepted.
 */
export async function withRetractableReport(
  early: boolean,
  report: () => (() => void) | undefined,
  work: (retractIfMissing: () => void) => Promise<boolean>,
): Promise<void> {
  let retract: (() => void) | undefined;
  try {
    if (early) retract = report();
  } catch {
    // Reporting never fails a delete.
  }
  try {
    const existed = await work(() => retract?.());
    if (existed && !early) report();
  } catch (err) {
    retract?.();
    throw err;
  }
}
