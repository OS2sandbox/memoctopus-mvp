import { z } from "zod";

import { PROMPT_CATEGORY } from "@/lib/constants";

const CreatorSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const PromptDTOSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  creator: CreatorSchema,
  category: z.enum(PROMPT_CATEGORY),
  isFavorite: z.boolean(),
  text: z.string(),
});

export const PromptSchema = PromptDTOSchema.extend({
  id: z.string(),
});

export type PromptDTO = z.infer<typeof PromptDTOSchema>;
export type Prompt = z.infer<typeof PromptSchema>;
