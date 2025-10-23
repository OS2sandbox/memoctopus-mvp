"use client";

import { Wizard } from "@/components/custom/wizard/Wizard";
import { type User, useSession } from "@/lib/auth-client";

// TODO: Dashboard will become "Add Speech To Text" view
export const DashboardView = () => {
  /*
  useEffect(() => {
    authClient.getSession().then((session) => {
      if (session?.data?.user) {
        setUser(session.data.user as User);
      } else {
        setUser(null);
      }
    });
  }, []);
   */

  const { data } = useSession();
  const user = data?.user as User | null;

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm">
        <h1 className="text-4xl font-bold mb-8 text-center">Dashboard</h1>

        <div className="rounded-lg border border-border bg-card p-8 shadow-sm">
          <h2 className="text-2xl font-semibold mb-4">
            Welcome, {user?.name || user?.email || "User"}
          </h2>

          <div className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Email</p>
              <p className="text-base">{user?.email || "Unknown"}</p>
            </div>

            {user?.name && (
              <div>
                <p className="text-sm text-muted-foreground">Name</p>
                <p className="text-base">{user.name}</p>
              </div>
            )}

            <div>
              <p className="text-sm text-muted-foreground">User ID</p>
              <p className="font-mono text-xs">{user?.id || "Unknown"}</p>
            </div>
          </div>
        </div>
      </div>
      <Wizard />
    </div>
  );
};
