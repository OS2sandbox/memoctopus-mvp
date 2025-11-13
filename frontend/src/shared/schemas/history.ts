import { z } from "zod";

import {
  MAX_HISTORY_TITLE_LENGTH,
  MAX_TRANSCRIPT_LENGTH,
  MIN_HISTORY_TITLE_LENGTH,
  MIN_TRANSCRIPT_LENGTH,
} from "@/shared/constants";
import { PromptSchema } from "@/shared/schemas/prompt";

export const TranscriptSchema = z.object({
  kind: z.literal("text"),
  text: z.string().trim().min(MIN_TRANSCRIPT_LENGTH).max(MAX_TRANSCRIPT_LENGTH),
});

export const HistoryAssetSchema = z.union([TranscriptSchema, PromptSchema]);

export const HistoryEntrySchema = z.object({
  id: z.string(),
  userId: z.string(),
  createdAt: z.coerce.date(),
  title: z
    .string()
    .trim()
    .min(MIN_HISTORY_TITLE_LENGTH)
    .max(MAX_HISTORY_TITLE_LENGTH),
  assets: z.array(HistoryAssetSchema).min(1),
});

export const HistoryEntryDTOSchema = HistoryEntrySchema.omit({
  id: true,
  createdAt: true,
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type HistoryEntryDTO = z.infer<typeof HistoryEntryDTOSchema>;
