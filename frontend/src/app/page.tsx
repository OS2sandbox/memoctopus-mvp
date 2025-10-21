import DashboardView from "@/components/custom/dashboard/DashboardView";
import { LandingView } from "@/components/custom/landing/LandingView";
import { authClient } from "@/lib/auth-client";

export default async function LandingPage() {
  const { getSession } = authClient;

  const session = await getSession();

  if (session.data) {
    return <DashboardView />;
  }

  return session.data ? <DashboardView /> : <LandingView />;
}
