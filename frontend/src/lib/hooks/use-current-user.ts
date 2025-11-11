import { useSession } from "@/lib/auth-client";

export const useCurrentUser = () => {
  const { data: session, isPending, error } = useSession();

  if (isPending) {
    throw new Error("useCurrentUser used while session is loading");
  }

  if (error || !session?.user) {
    throw new Error("User is required but not authenticated");
  }

  console.log("Current user:", session.user);

  return session.user;
};
