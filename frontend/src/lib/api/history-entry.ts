import {
  type HistoryEntry,
  type HistoryEntryDTO,
  HistoryEntrySchema,
} from "@/shared/schemas/history";
import { authClient } from "@/lib/auth-client";
import { getAuthAndCsrfHeaders } from "@/lib/api/csrf";

const API_BASE_URL =
  process.env["NEXT_PUBLIC_API_URL"] || "http://localhost:8000";

// Helper to create headers with auth token from session (for read-only requests)
async function getAuthHeaders(): Promise<HeadersInit> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  // Get session token from better-auth
  const session = await authClient.getSession();
  if (session?.data?.session?.token) {
    headers["X-Session-Token"] = session.data.session.token;
  }

  return headers;
}

export const getHistoryEntries = async (): Promise<HistoryEntry[]> => {
  const headers = await getAuthHeaders();

  const res = await fetch(`${API_BASE_URL}/api/history`, {
    headers,
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch history entries: ${res.statusText}`);
  }

  const json = await res.json();

  const result = HistoryEntrySchema.array().parse(json);

  console.log("Fetched history entries:", result);

  return result;
};

export const createHistoryEntry = async (
  entry: HistoryEntryDTO,
): Promise<HistoryEntry> => {
  const headers = await getAuthAndCsrfHeaders();

  const res = await fetch(`${API_BASE_URL}/api/history`, {
    method: "POST",
    headers,
    body: JSON.stringify(entry),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to create history entry: ${errorText}`);
  }

  const json = await res.json();

  const result = HistoryEntrySchema.parse(json);

  return result;
};

export const deleteHistoryEntry = async (id: string): Promise<void> => {
  const headers = await getAuthAndCsrfHeaders();

  const res = await fetch(`${API_BASE_URL}/api/history/${id}`, {
    method: "DELETE",
    headers,
  });

  if (!res.ok) {
    throw new Error(`Failed to delete history entry: ${res.statusText}`);
  }
};
