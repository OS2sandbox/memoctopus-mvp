import { STORAGE_KEY } from "@/mocks/constants";
import { mockPrompt } from "@/mocks/data/mockPrompt";
import {
  loadMockSessionData,
  saveMockSessionData,
} from "@/mocks/utils/mockSessionData";
import {
  type HistoryEntry,
  HistoryEntrySchema,
} from "@/shared/schemas/history";
import { type Prompt, PromptSchema } from "@/shared/schemas/prompt";

export const loadPrompts = (): Prompt[] =>
  loadMockSessionData({
    storageKey: STORAGE_KEY.MOCK_PROMPTS_STORE,
    schema: PromptSchema,
    fallbackData: mockPrompt,
  });

export const savePrompts = (data: Prompt[]) =>
  saveMockSessionData({
    storageKey: STORAGE_KEY.MOCK_PROMPTS_STORE,
    data,
  });

export const loadHistoryEntries = () => {
  const result = loadMockSessionData<HistoryEntry>({
    storageKey: STORAGE_KEY.MOCK_HISTORY_STORE,
    schema: HistoryEntrySchema,
  });

  return result;
};

export const saveHistoryEntries = (data: HistoryEntry[]) =>
  saveMockSessionData({
    storageKey: STORAGE_KEY.MOCK_HISTORY_STORE,
    data,
  });
