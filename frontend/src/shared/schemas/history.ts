import { z } from "zod";

import {
  MAX_HISTORY_TITLE_LENGTH,
  MAX_TRANSCRIPT_LENGTH,
  MIN_HISTORY_TITLE_LENGTH,
  MIN_TRANSCRIPT_LENGTH,
} from "@/shared/constants";

export const TranscriptSchema = z.object({
  kind: z.literal("text"),
  text: z.string().trim().min(MIN_TRANSCRIPT_LENGTH).max(MAX_TRANSCRIPT_LENGTH),
});

export const PromptAssetSchema = z.object({
    kind: z.literal("prompt"),
    promptId: z.string(),
    text: z
        .string()
        .trim()
        .min(5, "Summary text must be at least 5 characters")
        .max(50000, "Summary text must not exceed 50,000 characters"),
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
    .min(MIN_HISTORY_TITLE_LENGTH, "History entry title must be at least 5 characters")
    .max(MAX_HISTORY_TITLE_LENGTH, "History entry title must not exceed 200 characters"),
  assets: z.array(HistoryAssetSchema).min(1),
});

export const HistoryEntryDTOSchema = HistoryEntrySchema.omit({
  id: true,
  createdAt: true,
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type HistoryEntryDTO = z.infer<typeof HistoryEntryDTOSchema>;
