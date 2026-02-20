import { API_BASE_URL } from "@/lib/constants";
import {
  type HistoryEntry,
  type HistoryEntryDTO,
  HistoryEntrySchema,
  type HistoryEntryUpdateDTO,
} from "@/lib/schemas/history";
import { getAuthHeaders } from "@/lib/utils/utils";

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

  return result;
};

export const getHistoryEntry = async (id: string): Promise<HistoryEntry> => {
  const headers = await getAuthHeaders();

  const res = await fetch(`${API_BASE_URL}/api/history/${id}`, {
    headers,
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch history entry: ${res.statusText}`);
  }

  const json = await res.json();

  const result = HistoryEntrySchema.parse(json);

  return result;
};

export const createHistoryEntry = async (
  entry: HistoryEntryDTO,
): Promise<HistoryEntry> => {
  const headers = await getAuthHeaders();

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

interface UpdateHistoryEntryProps {
  id: string;
  update: HistoryEntryUpdateDTO;
}

export const updateHistoryEntry = async ({
  id,
  update,
}: UpdateHistoryEntryProps): Promise<HistoryEntry> => {
  const headers = await getAuthHeaders();

  const res = await fetch(`${API_BASE_URL}/api/history/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(update),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to update history entry: ${errorText}`);
  }

  const json = await res.json();

  const result = HistoryEntrySchema.parse(json);

  return result;
};

export const deleteHistoryEntry = async (id: string): Promise<void> => {
  const headers = await getAuthHeaders();

  const res = await fetch(`${API_BASE_URL}/api/history/${id}`, {
    method: "DELETE",
    headers,
  });

  if (!res.ok) {
    throw new Error(`Failed to delete history entry: ${res.statusText}`);
  }
};
