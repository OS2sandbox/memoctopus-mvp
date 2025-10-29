"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/core/shadcn/button";
import { Switch } from "@/components/core/shadcn/switch";
import { ViewPromptAction } from "@/components/custom/prompt-library/ViewPromptAction";
import { type User, useSession } from "@/lib/auth-client";

export interface Prompt {
  id: string;
  name: string;
  creator: Pick<User, "name" | "id">;
  category: string;
  isFavorite: boolean;
  text: string;
}

export const getColumns = (
  handleToggleFavorite: (id: string, checked: boolean) => void,
): ColumnDef<Prompt>[] => [
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
    header: "Handlinger",
    cell: ({ row }) => {
      const { data: session } = useSession();
      const user = session?.user as User | null;
      const prompt = row.original;

      const canEditOrDelete = prompt.creator.id === user?.id;

      return (
        <div className="flex items-center justify-center gap-1">
          <ViewPromptAction promptText={prompt.text} />

          {canEditOrDelete && (
            <Button variant="ghost" size="icon">
              <Pencil className="h-4 w-4" />
            </Button>
          )}

          {canEditOrDelete && (
            <Button variant="ghost" size="icon">
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          )}
        </div>
      );
    },
  },
];
