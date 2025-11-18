import type { ColumnDef } from "@tanstack/react-table";
import {
  LucideClipboardCopy,
  LucideFileDown,
  LucideFileText,
} from "lucide-react";

import type { HistoryEntry } from "@/lib/schemas/history";
import { Button } from "@/lib/ui/core/shadcn/button";
import type { TableAction } from "@/lib/ui/core/shadcn/data-table/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/lib/ui/core/shadcn/tooltip";

interface GetHistoryColumnsProps {
  handleGenerate: (promptText: string) => void;
  handleCopyPrompt: (promptText: string) => void;
  handleDownloadText: (promptText: string) => void;
}

const enum HISTORY_ACTION_TYPE {
  GENERATE = "generate",
  COPY_PROMPT = "copy_prompt",
  DOWNLOAD_TEXT = "download_text",
}

export const getHistoryColumns = ({
  handleGenerate,
  handleCopyPrompt,
  handleDownloadText,
}: GetHistoryColumnsProps): ColumnDef<HistoryEntry>[] => [
  {
    accessorKey: "title",
    header: "Titel",
    cell: ({ row }) => (
      <div className="font-medium text-foreground">{row.original.title}</div>
    ),
  },
  {
    accessorKey: "createdAt",
    header: "Dato",
    cell: ({ row }) => (
      <div className="font-medium text-foreground">
        {row.original.createdAt.toDateString()}
      </div>
    ),
  },
  {
    id: "actions",
    cell: ({ row }) => {
      const entry = row.original;

      const actions: TableAction<HISTORY_ACTION_TYPE>[] = [
        {
          key: HISTORY_ACTION_TYPE.GENERATE,
          component: (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleGenerate(entry.id)}
            >
              <LucideFileText />
            </Button>
          ),
          tooltipText: "Generer ny opsummering",
        },
        {
          key: HISTORY_ACTION_TYPE.COPY_PROMPT,
          component: (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleCopyPrompt(entry.id)}
            >
              <LucideClipboardCopy />
            </Button>
          ),
          tooltipText: "Kopiér prompt",
        },
        {
          key: HISTORY_ACTION_TYPE.DOWNLOAD_TEXT,
          component: (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleDownloadText(entry.id)}
            >
              <LucideFileDown />
            </Button>
          ),
          tooltipText: "Hent opsummering",
        },
      ];

      return (
        <div data-row-action className="flex items-center justify-end">
          {actions.map(({ key, component, tooltipText }) => (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <span className="inline-flex">{component}</span>
              </TooltipTrigger>
              <TooltipContent>{tooltipText}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      );
    },
  },
];
