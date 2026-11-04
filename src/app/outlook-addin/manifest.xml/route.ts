import { manifestResponse } from '@/lib/outlook/manifest-response';

/** The add-in's manifest, for the admin to upload in Integrated Apps. */
export async function GET() {
  return manifestResponse();
}
