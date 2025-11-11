import type { ColumnDef } from "@tanstack/react-table";
import {
  LucideClipboardCopy,
  LucideFileDown,
  LucideFileText,
} from "lucide-react";

import { Button } from "@/lib/ui/core/shadcn/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/lib/ui/core/shadcn/tooltip";
import type { HistoryEntry } from "@/shared/schemas/history";

interface GetHistoryColumnsProps {
  handleGenerate: (promptText: string) => void;
  handleCopyPrompt: (promptText: string) => void;
  handleDownloadText: (promptText: string) => void;
}

export const getHistoryColumns = ({
  handleGenerate,
  handleCopyPrompt,
  handleDownloadText,
}: GetHistoryColumnsProps): ColumnDef<HistoryEntry>[] => [
  {
    accessorKey: "name",
    header: "Navn",
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

      // TODO: abstract into separate component/factory
      return (
        <div className="flex items-center justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleGenerate(entry.id)}
                >
                  <LucideFileText />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Generer ny opsummering</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleCopyPrompt(entry.id)}
                >
                  <LucideClipboardCopy />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Kopiér opsummering</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDownloadText(entry.id)}
                >
                  <LucideFileDown />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Hent opsummering</TooltipContent>
          </Tooltip>
        </div>
      );
    },
  },
];
