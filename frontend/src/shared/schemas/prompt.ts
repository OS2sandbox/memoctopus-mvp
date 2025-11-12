import { z } from "zod";

import { PROMPT_CATEGORY } from "@/lib/constants";
import { MAX_PROMPT_LENGTH, MIN_PROMPT_LENGTH } from "@/shared/constants";

const CreatorSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const PromptSchema = z.object({
  id: z.string(),
  name: z.string(),
  creator: CreatorSchema,
  category: z.enum(PROMPT_CATEGORY),
  isFavorite: z.boolean(),
  text: z.string().trim().min(MIN_PROMPT_LENGTH).max(MAX_PROMPT_LENGTH),
});

export const PromptDTOSchema = PromptSchema.omit({
  id: true,
});

export type PromptDTO = z.infer<typeof PromptDTOSchema>;
export type Prompt = z.infer<typeof PromptSchema>;
