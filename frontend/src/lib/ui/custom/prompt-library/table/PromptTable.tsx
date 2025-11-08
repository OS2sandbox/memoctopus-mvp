"use client";

import { useSession } from "@/lib/auth-client";
import type { Prompt } from "@/lib/schemas/prompt";
import { DataTable } from "@/lib/ui/core/data-table";
import { ConfirmDialog } from "@/lib/ui/custom/dialog/ConfirmDialog";
import {
  type PromptTableOptions,
  usePromptTable,
} from "@/lib/ui/custom/prompt-library/hooks/usePromptTable";
import { getColumns } from "@/lib/ui/custom/prompt-library/table/Columns";
import { cn } from "@/lib/utils";

import { useState } from "react";

export const PromptTable = ({
  data,
  tableMode,
  className,
  hideAddButton,
  onRowClick,
}: Omit<PromptTableOptions, "currentUser">) => {
  const { data: session } = useSession();
  const user = session?.user ?? null;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);

  const handleRowClick = (prompt: Prompt) => {
    setSelectedPrompt(prompt);
    setConfirmOpen(true);
  };

  const handleConfirm = () => {
    if (selectedPrompt && onRowClick) {
      onRowClick(selectedPrompt);
    }

    setConfirmOpen(false);
  };

  const {
    prompts,
    scope,
    setScope,
    handleToggleFavorite,
    handleDeletePrompt,
    handleAddPrompt,
    handleUpdatePrompt,
  } = usePromptTable({ currentUser: user, tableMode: tableMode ?? [], data });

  const columns = getColumns({
    handleToggleFavorite,
    handleDeletePrompt,
    handleUpdatePrompt,
    currentUser: user,
  });

  return (
    <section className={cn("space-y-4 w-full max-w-5xl", className)}>
      <h2 className="text-2xl font-semibold">Prompt-bibliotek</h2>
      <DataTable<Prompt, typeof columns>
        columns={columns}
        data={prompts}
        {...(!hideAddButton && { onAdd: handleAddPrompt })}
        scopeOpts={{
          scope,
          onScopeChange: setScope,
          filterModes: tableMode ?? [],
        }}
        onRowClick={handleRowClick}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={() => setConfirmOpen((open) => !open)}
        onConfirm={handleConfirm}
      >
        <p>Er du sikker på, at du vil vælge denne prompt?</p>
        <p>Transkriberingen påbegynder, idet du godkender.</p>
      </ConfirmDialog>
    </section>
  );
};
