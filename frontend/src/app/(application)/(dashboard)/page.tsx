import {
  RedirectToSignIn,
  SignedIn,
} from "@/components/custom/auth/auth-components";
import { DashboardView } from "@/components/custom/dashboard/DashboardView";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <>
      <RedirectToSignIn />
      <SignedIn>
        <DashboardView />
      </SignedIn>
    </>
  );
}
