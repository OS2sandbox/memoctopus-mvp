"use client";

import type { ColumnDef } from "@tanstack/react-table";

import type { DATA_TABLE_SCOPE } from "@/lib/constants";
import { useCurrentUser } from "@/lib/hooks/use-current-user";
import { DataTable } from "@/lib/ui/core/data-table";
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { ConfirmDialog } from "@/lib/ui/custom/dialog/ConfirmDialog";
import { PromptDialog } from "@/lib/ui/custom/dialog/PromptDialog";
import { usePromptTable } from "@/lib/ui/custom/prompt-library/hooks/usePromptTable";
import { getPromptColumns } from "@/lib/ui/custom/prompt-library/table/PromptColumns";
import type { Prompt } from "@/shared/schemas/prompt";

import { Fragment, useEffect, useState } from "react";

export interface PromptTableProps {
  tableMode?: DATA_TABLE_SCOPE[];
  hideAddButton?: boolean;
  data: Prompt[];
  rowClickConfig?: {
    onRowClick: (prompt: Prompt) => void;
    status: string;
  };
}

export const PromptTable = ({
  data,
  tableMode,
  hideAddButton,
  rowClickConfig,
}: PromptTableProps) => {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);

  const user = useCurrentUser();

  const { onRowClick, status } = rowClickConfig ?? {};

  const handleRowClick = (prompt: Prompt) => {
    if (!rowClickConfig) return;
    setSelectedPrompt(prompt);
    setConfirmOpen(true);
  };

  const handleConfirm = () => {
    if (selectedPrompt && onRowClick) {
      onRowClick(selectedPrompt);
    }
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

  useEffect(() => {
    if (status === "success" && confirmOpen && selectedPrompt) {
      setConfirmOpen(false);
      setSelectedPrompt(null);
    }
  }, [status, confirmOpen, selectedPrompt]);

  const addDialog = <PromptDialog onSubmit={handleAddPrompt} />;

  return (
    <Fragment>
      <DataTable<Prompt, typeof columns>
        columns={columns}
        className={"max-w-4xl"}
        data={prompts}
        {...(!hideAddButton && { addButton: addDialog })}
        scopeOpts={{
          scope,
          onScopeChange: setScope,
          scopeModes: tableMode ?? [],
        }}
        onRowClick={handleRowClick}
        searchConfig={{
          filterKey: "name",
          placeholder: "Søg efter prompt...",
        }}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={handleConfirm}
        footerOpts={{
          footerDisabled: status === "pending",
        }}
      >
        {status === "pending" ? (
          <div className="flex flex-col items-center space-y-3">
            <p className="text-sm text-gray-500">Summerer...</p>
            <Spinner />
          </div>
        ) : (
          <div>
            <p>Er du sikker på, at du vil vælge denne prompt?</p>
            <p>Transkriberingen påbegynder, idet du godkender.</p>
          </div>
        )}
      </ConfirmDialog>
    </Fragment>
  );
};
