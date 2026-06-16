import { redirect } from 'next/navigation';

// Templates moved into Arkiv as the "Skabeloner" tab.
export default function TemplatesPage() {
  redirect('/arkiv?tab=skabeloner');
}
