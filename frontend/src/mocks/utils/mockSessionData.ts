import type { z } from "zod";

import type { STORAGE_KEY } from "@/mocks/constants";

interface LoadMockSessionDataProps<T> {
  storageKey: STORAGE_KEY;
  schema: z.ZodType<T>;
  fallbackData: T[];
}

export const loadMockSessionData = <T>({
  storageKey,
  schema,
  fallbackData,
}: LoadMockSessionDataProps<T>): T[] => {
  const raw = sessionStorage.getItem(storageKey);

  if (!raw) {
    sessionStorage.setItem(storageKey, JSON.stringify(fallbackData));
    return structuredClone(fallbackData);
  }

  try {
    const parsed = JSON.parse(raw);
    return schema.array().parse(parsed);
  } catch {
    sessionStorage.setItem(storageKey, JSON.stringify(fallbackData));
    return structuredClone(fallbackData);
  }
};

interface SaveMockSessionDataProps<T> {
  storageKey: STORAGE_KEY;
  data: T[];
}

export const saveMockSessionData = <T>({
  storageKey,
  data,
}: SaveMockSessionDataProps<T>) => {
  sessionStorage.setItem(storageKey, JSON.stringify(data));
};
