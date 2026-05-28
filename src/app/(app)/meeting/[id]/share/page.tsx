import { redirect } from 'next/navigation';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ShareRedirect({ params }: PageProps) {
  const { id } = await params;
  redirect(`/meeting/${id}/export`);
}
