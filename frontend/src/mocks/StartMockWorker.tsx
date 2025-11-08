"use client";

import { type ReactNode, useEffect, useState } from "react";

export function StartMockWorker({ children }: { children: ReactNode }) {
  const [isMockReady, setMockReady] = useState(false);

  useEffect(() => {
    async function enableMocks() {
      if (process.env.NODE_ENV === "development") {
        import("@/mocks/browser").then(({ worker }) => {
          void worker.start({
            onUnhandledRequest(req) {
              if (req.url.includes("localhost:8000")) return;
            },
          });
        });
      }

      setMockReady(true);
    }

    void enableMocks();
  }, []);

  if (!isMockReady) {
    return <div>Loading mocks...</div>;
  }

  return <>{children}</>;
}
