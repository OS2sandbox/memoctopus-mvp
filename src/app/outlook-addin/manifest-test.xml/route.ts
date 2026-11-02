import { manifestResponse } from '@/lib/outlook/manifest-response';

/**
 * The TEST add-in's manifest: a separate add-in, for a developer to sideload,
 * that probes what Outlook's send event can see. See docs/outlook-addin.md.
 */
export async function GET() {
  return manifestResponse('test');
}
