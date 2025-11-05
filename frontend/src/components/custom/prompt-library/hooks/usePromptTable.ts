"use client";

import type { DataTableScope } from "@/components/core/data-table";
import type { Prompt } from "@/components/custom/prompt-library/table/Columns";
import type { User } from "@/lib/auth-client";

import { useMemo, useState } from "react";

export interface PromptTableOptions {
  currentUser: User | null;
  tableMode?: {
    onlyMine?: boolean;
    onlyFavorites?: boolean;
  };
  data: Prompt[];
}

export const usePromptTable = ({
  currentUser,
  tableMode,
  data,
}: PromptTableOptions) => {
  const [prompts, setPrompts] = useState<Prompt[]>(data);

  const { onlyMine, onlyFavorites } = tableMode ?? {};

  const [scope, setScope] = useState<DataTableScope | null>(null);

  const handleToggleFavorite = (id: string, checked: boolean) =>
    setPrompts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, isFavorite: checked } : p)),
    );

  const handleDeletePrompt = (id: string) =>
    setPrompts((prev) => prev.filter((p) => p.id !== id));

  const handleAddPrompt = (newPrompt: Prompt) =>
    setPrompts((prev) => [...prev, newPrompt]);

  const handleUpdatePrompt = (updatedPrompt: Prompt) =>
    setPrompts((prev) =>
      prev.map((p) => (p.id === updatedPrompt.id ? updatedPrompt : p)),
    );

  const filteredPrompts = useMemo(() => {
    return prompts.filter((p) => {
      if (onlyMine && p.creator.id !== currentUser?.id) return false;
      return !(onlyFavorites && !p.isFavorite);
    });
  }, [prompts, currentUser?.id, onlyMine, onlyFavorites]);

  return {
    prompts: filteredPrompts,
    scope,
    setScope,
    handleToggleFavorite,
    handleDeletePrompt,
    handleAddPrompt,
    handleUpdatePrompt,
  };
};
