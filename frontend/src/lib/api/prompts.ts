import { API_BASE_URL } from "@/lib/constants";
import {
  type Prompt,
  type PromptDTO,
  PromptSchema,
} from "@/lib/schemas/prompt";
import { getAuthHeaders } from "@/lib/utils/utils";

export const getPrompts = async (): Promise<Prompt[]> => {
  const headers = await getAuthHeaders();

  const res = await fetch(`${API_BASE_URL}/api/prompts`, {
    headers,
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch prompts: ${res.statusText}`);
  }

  const json = await res.json();

  const result = PromptSchema.array().parse(json);

  return result;
};

export const createPrompt = async (prompt: PromptDTO): Promise<Prompt> => {
  const headers = await getAuthHeaders();

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
  const headers = await getAuthHeaders();

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
  const headers = await getAuthHeaders();

  const res = await fetch(`${API_BASE_URL}/api/prompts/${id}`, {
    method: "DELETE",
    headers,
  });

  if (!res.ok) {
    throw new Error(`Failed to delete prompt: ${res.statusText}`);
  }
};
