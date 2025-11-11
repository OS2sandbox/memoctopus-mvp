import { z } from "zod";

export const TranscriptSchema = z.object({
  kind: z.literal("text"),
  text: z.string().min(1),
});

export const FileAudioSchema = z.object({
  storage: z.literal("file"),
  kind: z.literal("audio"),
  file: z.object({
    name: z.string(),
    size: z.number().positive(),
    type: z.string(),
  }),
  durationSec: z.number().positive().optional(),
});

export const HistoryAssetSchema = z.union([TranscriptSchema, FileAudioSchema]);

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
export type FileAudio = z.infer<typeof FileAudioSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type HistoryEntryDTO = z.infer<typeof HistoryEntryDTOSchema>;
