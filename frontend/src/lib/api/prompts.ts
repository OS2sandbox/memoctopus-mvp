import { type Prompt, PromptSchema } from "@/shared/schemas/prompt";

export const getPrompts = async (): Promise<Prompt[]> => {
  const res = await fetch("/api/prompts");
  const json = await res.json();

  const result = PromptSchema.array().parse(json);

  return result;
};
