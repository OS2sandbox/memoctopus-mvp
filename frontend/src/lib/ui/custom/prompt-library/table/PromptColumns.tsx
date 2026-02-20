"use client";

import type { TableAction } from "@/lib/ui/core/shadcn/data-table/types";

("use no memo");

import type { ColumnDef } from "@tanstack/react-table";

import type { User } from "@/lib/auth-client";
import { DATA_TABLE_SCOPE } from "@/lib/constants";
import type { Prompt, PromptDTO } from "@/lib/schemas/prompt";
import { Switch } from "@/lib/ui/core/shadcn/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/lib/ui/core/shadcn/tooltip";
import { DeletePromptAction } from "@/lib/ui/custom/prompt-library/table/action/DeletePromptAction";
import { EditPromptAction } from "@/lib/ui/custom/prompt-library/table/action/EditPromptAction";
import { ViewPromptAction } from "@/lib/ui/custom/prompt-library/table/action/ViewPromptAction";

interface GetPromptColumnsProps {
  handleToggleFavorite: (id: string, checked: boolean) => void;
  handleDeletePrompt: (id: string) => void;
  handleUpdatePrompt: (promptId: string, dto: PromptDTO) => void;
  user: User;
}

enum PROMPT_ACTION_TYPE {
  View = "view",
  Edit = "edit",
  Delete = "delete",
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
      const isMutable = prompt.creator.id === user?.id;

      const actions: TableAction<PROMPT_ACTION_TYPE>[] = [
        {
          key: PROMPT_ACTION_TYPE.View,
          component: <ViewPromptAction promptText={prompt.text} />,
          tooltipText: "Se skabelon",
        },
        {
          key: PROMPT_ACTION_TYPE.Edit,
          component: (
            <EditPromptAction
              prompt={prompt}
              canEdit={isMutable}
              onUpdate={(dto) => handleUpdatePrompt(prompt.id, dto)}
            />
          ),
          tooltipText: "Rediger skabelon",
        },
        {
          key: PROMPT_ACTION_TYPE.Delete,
          component: (
            <DeletePromptAction
              canDelete={isMutable}
              onDelete={() => handleDeletePrompt(prompt.id)}
            />
          ),
          tooltipText: "Slet skabelon",
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
