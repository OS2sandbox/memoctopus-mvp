/**
 * Waits for `work`, but at most `ms`. Resolves to true when the time ran out first (the work keeps
 * running in the background), false when it finished; rejects when the work rejects in time.
 * Used where an audit write or delivery must never hold up a login or a sign-out.
 */
export async function withTimeout(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
