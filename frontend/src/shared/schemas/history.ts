import { z } from "zod";

import { PromptSchema } from "@/shared/schemas/prompt";

export const TranscriptSchema = z.object({
  kind: z.literal("text"),
  text: z.string().min(1),
});

export const HistoryAssetSchema = z.union([TranscriptSchema, PromptSchema]);

export const HistoryEntrySchema = z.object({
  id: z.string(),
  userId: z.string(),
  createdAt: z.coerce.date(),
  title: z.string(),
  assets: z.array(HistoryAssetSchema).min(1),
});

export const HistoryEntryDTOSchema = HistoryEntrySchema.omit({
  id: true,
  createdAt: true,
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type HistoryEntryDTO = z.infer<typeof HistoryEntryDTOSchema>;
