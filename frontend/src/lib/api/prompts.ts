import { type Prompt, PromptWithIdSchema } from "@/mocks/schemas/prompt";

export const getPrompts = async (): Promise<Prompt[]> => {
  const res = await fetch("/api/prompts");
  const json = await res.json();

  const result = PromptWithIdSchema.array().parse(json);

  return result;
};
