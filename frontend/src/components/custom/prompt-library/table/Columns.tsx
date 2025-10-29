"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { LucidePencil, LucideTrash2 } from "lucide-react";

import { Button } from "@/components/core/shadcn/button";
import { Switch } from "@/components/core/shadcn/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/core/shadcn/tooltip";
import { ViewPromptAction } from "@/components/custom/prompt-library/ViewPromptAction";
import { type User, useSession } from "@/lib/auth-client";

export enum PromptCategory {
  Beslutningsreferat = "Beslutningsreferat",
  API = "API",
  ToDoListe = "To do liste",
  DetaljeretReferat = "Detaljeret referat",
  KortReferat = "Kort referat",
}

export interface Prompt {
  id: string;
  name: string;
  creator: Pick<User, "name" | "id">;
  category: PromptCategory;
  isFavorite: boolean;
  text: string;
}

interface getColumnsProps {
  handleToggleFavorite: (id: string, checked: boolean) => void;
  handleDeletePrompt: (id: string) => void;
}

export const getColumns = ({
  handleToggleFavorite,
  handleDeletePrompt,
}: getColumnsProps): ColumnDef<Prompt>[] => [
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
    accessorKey: "creator.name",
    header: "Oprettet af",
    cell: ({ row }) => <span>{row.original.creator.name}</span>,
  },
  {
    accessorKey: "category",
    header: "Kategori",
  },
  {
    id: "actions",
    cell: ({ row }) => {
      const { data: session } = useSession();
      const user = session?.user as User | null;
      const prompt = row.original;

      const canEditOrDelete = prompt.creator.id === user?.id;

      // abstract into separate component/factory
      return (
        <div className="flex items-center justify-end">
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
                <Button variant="ghost" size="icon" disabled={!canEditOrDelete}>
                  <LucidePencil />
                </Button>
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
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!canEditOrDelete}
                  onClick={() => handleDeletePrompt(prompt.id)}
                >
                  <LucideTrash2 />
                </Button>
              </span>
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
