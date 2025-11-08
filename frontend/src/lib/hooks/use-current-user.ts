import { useSession } from "@/lib/auth-client";

export const useCurrentUser = () => {
  const { data: session } = useSession();
  const result = session?.user ?? null;

  return result;
};
