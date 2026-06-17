import { z } from "zod";

import {
  MAX_ASSET_NAME_LENGTH,
  MAX_PROMPT_LENGTH,
  MIN_ASSET_NAME_LENGTH,
  MIN_PROMPT_LENGTH,
  PROMPT_CATEGORY,
} from "@/lib/constants";

const CreatorSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const PromptSchema = z.object({
  id: z.string(),
  name: z
    .string()
    .trim()
    .min(
      MIN_ASSET_NAME_LENGTH,
      `Promptens navn skal være mindst ${MIN_ASSET_NAME_LENGTH} tegn`,
    )
    .max(
      MAX_ASSET_NAME_LENGTH,
      `Promptens navn må ikke overgå ${MAX_ASSET_NAME_LENGTH} tegn`,
    ),
  creator: CreatorSchema,
  category: z.enum(PROMPT_CATEGORY),
  isFavorite: z.boolean(),
  text: z
    .string()
    .trim()
    .min(
      MIN_PROMPT_LENGTH,
      `Promptens tekst skal være mindst ${MIN_PROMPT_LENGTH} tegn`,
    )
    .max(
      MAX_PROMPT_LENGTH,
      `Promptens tekst må ikke overgå ${MAX_PROMPT_LENGTH} tegn`,
    ),
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
});

export const PromptDTOSchema = PromptSchema.omit({
  id: true,
  creator: true,
  createdAt: true,
  updatedAt: true,
});

export type PromptDTO = z.infer<typeof PromptDTOSchema>;
export type Prompt = z.infer<typeof PromptSchema>;
