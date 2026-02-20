"use client";

import type { ColumnDef } from "@tanstack/react-table";

import type { DATA_TABLE_SCOPE } from "@/lib/constants";
import { useCurrentUser } from "@/lib/hooks/use-current-user";
import type { Prompt } from "@/lib/schemas/prompt";
import { DataTable } from "@/lib/ui/core/shadcn/data-table/data-table";
import { PromptDialog } from "@/lib/ui/custom/dialog/PromptDialog";
import { getPromptColumns } from "@/lib/ui/custom/prompt-library/table/PromptColumns";
import { usePromptTable } from "@/lib/ui/custom/prompt-library/table/usePromptTable";

export interface PromptTableProps {
  tableMode?: DATA_TABLE_SCOPE[];
  hideAddButton?: boolean;
  data: Prompt[];
  rowClickConfig?: {
    onRowClick: (prompt: Prompt) => void;
    selectedPromptId?: string | undefined;
  };
}

export const PromptTable = ({
  data,
  tableMode,
  hideAddButton,
  rowClickConfig,
}: PromptTableProps) => {
  const user = useCurrentUser();

  const { onRowClick, selectedPromptId } = rowClickConfig ?? {};

  const handleRowClick = (prompt: Prompt) => {
    if (!rowClickConfig) return;
    onRowClick?.(prompt);
  };

  const {
    prompts,
    scope,
    setScope,
    handleToggleFavorite,
    handleDeletePrompt,
    handleAddPrompt,
    handleUpdatePrompt,
  } = usePromptTable({ tableMode: tableMode ?? [], data });

  const columns: ColumnDef<Prompt>[] = getPromptColumns({
    handleToggleFavorite,
    handleDeletePrompt,
    handleUpdatePrompt,
    user,
  });

  const addDialog = <PromptDialog onSubmit={handleAddPrompt} />;

  const addButtonConfig = {
    addButton: addDialog,
    ...(hideAddButton ? { onlyIfSearchEmpty: true } : {}),
  };

  return (
    <DataTable<Prompt, typeof columns>
      columns={columns}
      className={"max-w-4xl"}
      data={prompts}
      addButtonConfig={addButtonConfig}
      scopeOpts={{
        scope,
        onScopeChange: setScope,
        scopeModes: tableMode ?? [],
      }}
      onRowClick={handleRowClick}
      selectedRowId={selectedPromptId}
      searchConfig={{
        filterKey: "name",
        placeholder: "Søg efter skabelon...",
      }}
    />
  );
};
