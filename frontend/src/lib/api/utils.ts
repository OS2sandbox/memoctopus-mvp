import { authClient } from "@/lib/auth-client";

export async function getAuthHeaders(): Promise<HeadersInit> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  const session = await authClient.getSession();
  if (session?.data?.session?.token) {
    headers["X-Session-Token"] = session.data.session.token;
  }

  return headers;
}
