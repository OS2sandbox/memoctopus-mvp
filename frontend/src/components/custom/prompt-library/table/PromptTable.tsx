"use client";

import { DataTable } from "@/components/core/data-table";
import {
  type PromptTableOptions,
  usePromptTable,
} from "@/components/custom/prompt-library/hooks/usePromptTable";
import { getColumns } from "@/components/custom/prompt-library/table/Columns";
import { useSession } from "@/lib/auth-client";

export const PromptTable = ({
  data,
  tableMode,
}: Omit<PromptTableOptions, "currentUser">) => {
  const { data: session } = useSession();
  const user = session?.user ?? null;

  const {
    prompts,
    scope,
    setScope,
    handleToggleFavorite,
    handleDeletePrompt,
    handleAddPrompt,
    handleUpdatePrompt,
  } = usePromptTable({ currentUser: user, tableMode: tableMode ?? {}, data });

  const columns = getColumns({
    handleToggleFavorite,
    handleDeletePrompt,
    handleUpdatePrompt,
    currentUser: user,
  });

  return (
    <section className="space-y-4 w-full max-w-5xl">
      <h2 className="text-2xl font-semibold">Prompt-bibliotek</h2>
      <DataTable
        columns={columns}
        data={prompts}
        onAdd={handleAddPrompt}
        scopeOpts={{ scope, onScopeChange: setScope }}
      />
    </section>
  );
};
