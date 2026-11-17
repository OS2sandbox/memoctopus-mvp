// How often the diarize route emits an NDJSON ping while the diarization service
// works, so idle-connection middleboxes (VPN, firewall, proxy) see bytes flowing.
// Lives outside route.ts: a Next.js route module may only export handlers and
// route config, and `next build` rejects any other export.
export const DIARIZE_PING_INTERVAL_MS = 15_000;
