"use client";

import { useSession } from "@/lib/auth-client";
import { DataTable } from "@/lib/ui/core/data-table";
import {
  type PromptTableOptions,
  usePromptTable,
} from "@/lib/ui/custom/prompt-library/hooks/usePromptTable";
import { getColumns } from "@/lib/ui/custom/prompt-library/table/Columns";
import { cn } from "@/lib/utils";

export const PromptTable = ({
  data,
  tableMode,
  className,
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
      <DataTable
        columns={columns}
        data={prompts}
        onAdd={handleAddPrompt}
        scopeOpts={{
          scope,
          onScopeChange: setScope,
          filterModes: tableMode ?? [],
        }}
      />
    </section>
  );
};
