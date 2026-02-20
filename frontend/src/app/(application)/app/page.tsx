import { DashboardView } from "@/app/(application)/app/DashboardView";

import { Suspense } from "react";

export default function AppPage() {
  return (
    <main className="flex flex-col items-center justify-start min-h-screen">
      <Suspense fallback={null}>
        <DashboardView />
      </Suspense>
    </main>
  );
}
