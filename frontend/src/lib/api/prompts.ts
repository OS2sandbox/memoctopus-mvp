import { authClient } from "@/lib/auth-client";
import {
  type Prompt,
  type PromptDTO,
  PromptSchema,
} from "@/shared/schemas/prompt";
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

export const getPrompts = async (): Promise<Prompt[]> => {
  const headers = await getAuthHeaders();

  const res = await fetch(`${API_BASE_URL}/api/prompts`, {
    headers,
  });

  console.log("Fetch prompts response status:", headers);

  if (!res.ok) {
    throw new Error(`Failed to fetch prompts: ${res.statusText}`);
  }

  const json = await res.json();

  const result = PromptSchema.array().parse(json);

  return result;
};

export const createPrompt = async (prompt: PromptDTO): Promise<Prompt> => {
  const headers = await getAuthAndCsrfHeaders();

  const res = await fetch(`${API_BASE_URL}/api/prompts`, {
    method: "POST",
    headers,
    body: JSON.stringify(prompt),
  });

  if (!res.ok) {
    throw new Error(`Failed to create prompt: ${res.statusText}`);
  }

  const json = await res.json();

  const result = PromptSchema.parse(json);

  return result;
};

export const updatePrompt = async (
  id: string,
  prompt: PromptDTO,
): Promise<Prompt> => {
  const headers = await getAuthAndCsrfHeaders();

  const res = await fetch(`${API_BASE_URL}/api/prompts/${id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(prompt),
  });

  if (!res.ok) {
    throw new Error(`Failed to update prompt: ${res.statusText}`);
  }

  const json = await res.json();

  const result = PromptSchema.parse(json);

  return result;
};

export const deletePrompt = async (id: string): Promise<void> => {
  const headers = await getAuthAndCsrfHeaders();

  const res = await fetch(`${API_BASE_URL}/api/prompts/${id}`, {
    method: "DELETE",
    headers,
  });

  if (!res.ok) {
    throw new Error(`Failed to delete prompt: ${res.statusText}`);
  }
};
