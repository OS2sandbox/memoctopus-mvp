"use client";

import { ConfirmDialog } from "@/lib/ui/custom/dialog/ConfirmDialog";

("use no memo");

import type { Prompt } from "@/shared/schemas/prompt";
// Known issue that React Compiler is not supported by TanStack table yet:

// https://nextjs.org/docs/app/api-reference/config/next-config-js/reactCompiler

import type { ColumnDef } from "@tanstack/react-table";
import { LucidePencil, LucideTrash2 } from "lucide-react";

import type { User } from "@/lib/auth-client";
import { DATA_TABLE_SCOPE } from "@/lib/constants";
import { Button } from "@/lib/ui/core/shadcn/button";
import { Switch } from "@/lib/ui/core/shadcn/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/lib/ui/core/shadcn/tooltip";
import { PromptDialog } from "@/lib/ui/custom/dialog/PromptDialog";
import { ViewPromptAction } from "@/lib/ui/custom/prompt-library/table/ViewPromptAction";

import { useState } from "react";

interface GetPromptColumnsProps {
  handleToggleFavorite: (id: string, checked: boolean) => void;
  handleDeletePrompt: (id: string) => void;
  handleUpdatePrompt: (prompt: Prompt) => void;
  user: User;
}

export const getPromptColumns = ({
  handleToggleFavorite,
  handleDeletePrompt,
  handleUpdatePrompt,
  user,
}: GetPromptColumnsProps): ColumnDef<Prompt>[] => [
  {
    accessorKey: "isFavorite",
    header: "Favorit",
    cell: ({ row }) => {
      const prompt = row.original;
      return (
        <Switch
          checked={prompt.isFavorite}
          onCheckedChange={(checked) =>
            handleToggleFavorite(prompt.id, checked)
          }
        />
      );
    },
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: "name",
    header: "Navn",
    cell: ({ row }) => (
      <div className="font-medium text-foreground">{row.original.name}</div>
    ),
  },
  {
    accessorKey: "creator",
    header: "Oprettet af",
    cell: ({ row }) => <span>{row.original.creator.name}</span>,
    filterFn: (row, _columnId, filterValue) => {
      const creator = row.original.creator;
      if (filterValue === DATA_TABLE_SCOPE.MyItems) {
        return creator.id === user?.id;
      }
      // For "My Organization", implement organization logic as needed (waiting for backend support)
      return true;
    },
  },
  {
    accessorKey: "category",
    header: "Kategori",
  },
  {
    id: "actions",
    cell: ({ row }) => {
      const prompt = row.original;
      const [open, setOpen] = useState(false);

      const canEditOrDelete = prompt.creator.id === user?.id;

      // TODO: abstract into separate component/factory
      return (
        <div data-row-action className="flex items-center justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <ViewPromptAction promptText={prompt.text} />
              </span>
            </TooltipTrigger>
            <TooltipContent>Se prompt</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <PromptDialog
                  editOpts={{ initialPrompt: prompt }}
                  onSubmit={handleUpdatePrompt}
                  trigger={
                    <Button disabled={!canEditOrDelete} variant="ghost">
                      <LucidePencil />
                    </Button>
                  }
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {canEditOrDelete
                ? "Rediger prompt"
                : "Du kan kun redigere dine egne prompts"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <ConfirmDialog
                open={open}
                onOpenChange={setOpen}
                onConfirm={() => handleDeletePrompt(prompt.id)}
                trigger={
                  <span className="inline-flex">
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!canEditOrDelete}
                    >
                      <LucideTrash2 />
                    </Button>
                  </span>
                }
                footerOpts={{
                  isConfirmDestructive: true,
                }}
              >
                <p>Er du sikker, at du vil slette denne prompt?</p>
                <p>Idet du bekræfter, kan du ikke tilbagekalde prompten.</p>
              </ConfirmDialog>
            </TooltipTrigger>
            <TooltipContent>
              {canEditOrDelete
                ? "Slet prompt"
                : "Du kan kun slette dine egne prompts"}
            </TooltipContent>
          </Tooltip>
        </div>
      );
    },
  },
];
