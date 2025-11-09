"use client";

import type { User } from "@/lib/auth-client";
import type { FILTER_MODE } from "@/lib/constants";
import type { Prompt } from "@/lib/schemas/prompt";
import { DataTable } from "@/lib/ui/core/data-table";
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { ConfirmDialog } from "@/lib/ui/custom/dialog/ConfirmDialog";
import { PromptDialog } from "@/lib/ui/custom/dialog/PromptDialog";
import { usePromptTable } from "@/lib/ui/custom/prompt-library/hooks/usePromptTable";
import { getColumns } from "@/lib/ui/custom/prompt-library/table/Columns";
import { cn } from "@/lib/utils/utils";

import { Fragment, useEffect, useState } from "react";

export interface PromptTableProps {
  currentUser: User | null;
  tableMode?: FILTER_MODE[];
  hideAddButton?: boolean;
  data: Prompt[];
  className?: string;
  rowClickConfig?: {
    onRowClick: (prompt: Prompt) => void;
    status: string;
  };
}

export const PromptTable = ({
  data,
  tableMode,
  className,
  hideAddButton,
  currentUser,
  rowClickConfig,
}: PromptTableProps) => {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);

  const { onRowClick, status } = rowClickConfig || {};

  const handleRowClick = (prompt: Prompt) => {
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
  } = usePromptTable({ currentUser, tableMode: tableMode ?? [], data });

  const columns = getColumns({
    handleToggleFavorite,
    handleDeletePrompt,
    handleUpdatePrompt,
    currentUser,
  });

  useEffect(() => {
    if (status === "success" && confirmOpen && selectedPrompt) {
      setConfirmOpen(false);
      setSelectedPrompt(null);
    }
  }, [status, confirmOpen, selectedPrompt]);

  const addButton = <PromptDialog onSubmit={handleAddPrompt} />;

  return (
    <section className={cn("space-y-4 w-full max-w-5xl", className)}>
      <h2 className="text-2xl font-semibold">Prompt-bibliotek</h2>
      <DataTable<Prompt, typeof columns>
        columns={columns}
        data={prompts}
        {...(!hideAddButton && { addButton: addButton })}
        scopeOpts={{
          scope,
          onScopeChange: setScope,
          filterModes: tableMode ?? [],
        }}
        onRowClick={handleRowClick}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={handleConfirm}
        footerDisabled={status === "pending"}
      >
        {status === "pending" ? (
          <div className="flex flex-col items-center space-y-3">
            <p className="text-sm text-gray-500">Summerer...</p>
            <Spinner />
          </div>
        ) : (
          <Fragment>
            <p>Er du sikker på, at du vil vælge denne prompt?</p>
            <p>Transkriberingen påbegynder, idet du godkender.</p>
          </Fragment>
        )}
      </ConfirmDialog>
    </section>
  );
};
