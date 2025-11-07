import { z } from "zod";

import { PromptCategory } from "@/lib/constants";

const CreatorSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const PromptSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  creator: CreatorSchema,
  category: z.enum(PromptCategory),
  isFavorite: z.boolean(),
  text: z.string(),
});

export const PromptWithIdSchema = PromptSchema.extend({
  id: z.string(),
});

export type Prompt = z.infer<typeof PromptWithIdSchema>;
