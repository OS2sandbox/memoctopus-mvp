import { type Prompt, PromptWithIdSchema } from "@/lib/schemas/prompt";
import { mockPrompts } from "@/mocks/data/prompts";

const STORAGE_KEY = "mock_prompts_store";

export const loadPrompts = (): Prompt[] => {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(mockPrompts));
    return structuredClone(mockPrompts);
  }
  try {
    const parsed = JSON.parse(raw);
    return PromptWithIdSchema.array().parse(parsed);
  } catch {
    return structuredClone(mockPrompts);
  }
};

export const savePrompts = (prompts: Prompt[]) => {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
};
