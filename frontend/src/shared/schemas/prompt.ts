import { z } from "zod";

import { PROMPT_CATEGORY } from "@/lib/constants";
import {
  MAX_ASSET_NAME_LENGTH,
  MAX_PROMPT_LENGTH,
  MIN_ASSET_NAME_LENGTH,
  MIN_PROMPT_LENGTH,
} from "@/shared/constants";

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
      `Prompt name must be at least ${MIN_ASSET_NAME_LENGTH} characters`,
    )
    .max(
      MAX_ASSET_NAME_LENGTH,
      `Prompt name must not exceed ${MAX_ASSET_NAME_LENGTH} characters`,
    ),
  creator: CreatorSchema,
  category: z.enum(PROMPT_CATEGORY),
  isFavorite: z.boolean(),
  text: z
    .string()
    .trim()
    .min(
      MIN_PROMPT_LENGTH,
      `Prompt text must be at least ${MIN_PROMPT_LENGTH} characters`,
    )
    .max(
      MAX_PROMPT_LENGTH,
      `"Prompt text must not exceed ${MAX_PROMPT_LENGTH} characters"`,
    ),
});

export const PromptDTOSchema = PromptSchema.omit({
  id: true,
});

export type PromptDTO = z.infer<typeof PromptDTOSchema>;
export type Prompt = z.infer<typeof PromptSchema>;
