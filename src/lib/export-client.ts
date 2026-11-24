import { z } from 'zod';
import type { MinutesContent } from '@/types';

const ErrorBody = z.object({ error: z.string() });

/**
 * Renders a document through `POST /api/export/[id]` and saves the reply in the
 * browser under `filename`. Rejects with the server's error message when it gives
 * one, else with "Eksport fejlede".
 */
export async function downloadExport({ meetingId, title, content, format, filename }: {
  meetingId: string;
  title: string;
  content: MinutesContent;
  format: 'pdf' | 'docx' | 'md';
  filename: string;
}): Promise<void> {
  const res = await fetch(`/api/export/${meetingId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content, format }),
  });
  if (!res.ok) {
    // A proxy in front can answer with an HTML error page; that is no message to show.
    const parsed = ErrorBody.safeParse(await res.json().catch(() => null));
    throw new Error(parsed.success ? parsed.data.error : 'Eksport fejlede');
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
