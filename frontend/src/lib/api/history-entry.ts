import {
  type HistoryEntry,
  type HistoryEntryDTO,
  HistoryEntrySchema,
} from "@/shared/schemas/history";

export const getHistoryEntries = async (): Promise<HistoryEntry[]> => {
  const res = await fetch("/api/history");

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
  const res = await fetch("/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
