export function getBotServiceConfig(): { url: string; authHeader: string } | null {
  const url = process.env.BOT_SERVICE_URL;
  if (!url) return null;
  return { url, authHeader: `Bearer ${process.env.BOT_INTERNAL_SECRET ?? ''}` };
}

export function botFetch(
  config: { url: string; authHeader: string },
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${config.url}${path}`, {
    ...init,
    headers: { Authorization: config.authHeader, ...init?.headers as Record<string, string> },
    signal: AbortSignal.timeout(10_000),
  });
}
