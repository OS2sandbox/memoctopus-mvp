import { z } from "zod";

import {
  MAX_ASSET_NAME_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_TRANSCRIPT_LENGTH,
  MIN_ASSET_NAME_LENGTH,
  MIN_PROMPT_LENGTH,
  MIN_TRANSCRIPT_LENGTH,
} from "@/lib/constants";

export const TranscriptSchema = z.object({
  kind: z.literal("transcript"),
  text: z
    .string()
    .trim()
    .min(
      MIN_TRANSCRIPT_LENGTH,
      `Transcript text must be at least ${MIN_TRANSCRIPT_LENGTH} characters`,
    )
    .max(
      MAX_TRANSCRIPT_LENGTH,
      `Transcript text must not exceed ${MAX_TRANSCRIPT_LENGTH} characters`,
    ),
});

export const PromptAssetSchema = z.object({
  kind: z.literal("prompt"),
  promptId: z.string(),
  text: z
    .string()
    .trim()
    .min(
      MIN_PROMPT_LENGTH,
      `Summary text must be at least ${MIN_PROMPT_LENGTH} characters`,
    )
    .max(
      MAX_PROMPT_LENGTH,
      `Summary text must not exceed ${MAX_PROMPT_LENGTH} characters`,
    ),
});

export const HistoryAssetSchema = z.union([
  TranscriptSchema,
  PromptAssetSchema,
]);

export const HistoryEntrySchema = z.object({
  id: z.string(),
  userId: z.string(),
  createdAt: z.coerce.date(),
  title: z
    .string()
    .trim()
    .min(
      MIN_ASSET_NAME_LENGTH,
      `History entry title must be at least ${MIN_ASSET_NAME_LENGTH} characters`,
    )
    .max(
      MAX_ASSET_NAME_LENGTH,
      `History entry title must not exceed ${MAX_ASSET_NAME_LENGTH} characters`,
    ),
  assets: z.array(HistoryAssetSchema).min(1),
});

export const HistoryEntryDTOSchema = HistoryEntrySchema.omit({
  id: true,
  createdAt: true,
});

export const HistoryEntryUpdateDTOSchema = HistoryEntryDTOSchema.partial();

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type HistoryEntryDTO = z.infer<typeof HistoryEntryDTOSchema>;
export type HistoryEntryUpdateDTO = z.infer<typeof HistoryEntryUpdateDTOSchema>;
