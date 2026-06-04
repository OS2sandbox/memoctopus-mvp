export function getBotServiceConfig(): { url: string; authHeader: string } | null {
  const url = process.env.BOT_SERVICE_URL;
  if (!url) return null;
  return { url, authHeader: `Bearer ${process.env.BOT_INTERNAL_SECRET ?? ''}` };
}
