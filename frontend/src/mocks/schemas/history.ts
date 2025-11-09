import { z } from "zod";

export const TranscriptSchema = z.object({
  id: z.string().optional(),
  kind: z.literal("text"),
  text: z.string().min(1),
});

export const FileAudioSchema = z.object({
  storage: z.literal("file"),
  kind: z.literal("audio"),
  file: z.instanceof(File),
  durationSec: z.number().positive().optional(),
});

export const HistoryAssetSchema = z.union([TranscriptSchema, FileAudioSchema]);

export const HistoryEntrySchema = z.object({
  id: z.string(),
  userId: z.string(),
  createdAt: z.date(),
  title: z.string(),
  assets: z.array(HistoryAssetSchema).min(1),
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type FileAudio = z.infer<typeof FileAudioSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
