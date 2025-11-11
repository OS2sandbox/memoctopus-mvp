"use client";

import { DATA_TABLE_SCOPE } from "@/lib/constants";
import { useCurrentUser } from "@/lib/hooks/use-current-user";
import type { PromptTableProps } from "@/lib/ui/custom/prompt-library/table/PromptTable";
import type { Prompt } from "@/shared/schemas/prompt";

import { useState } from "react";

export const usePromptTable = ({
  tableMode,
  data,
}: Omit<PromptTableProps, "className" | "hideAddButton" | "isProcessing">) => {
  const { user } = useCurrentUser();

  const [prompts, setPrompts] = useState<Prompt[]>(data);

  const [scope, setScope] = useState<DATA_TABLE_SCOPE | null>(null);

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

  const filteredPrompts = prompts.filter((prompt) => {
    if (tableMode?.length === 0 || !tableMode) return true;

    const result = tableMode.some((mode) => {
      switch (mode) {
        case DATA_TABLE_SCOPE.MyItems:
          return prompt.creator.id === user?.id;

        case DATA_TABLE_SCOPE.MyFavorites:
          return prompt.isFavorite;

        default:
          return false;
      }
    });

    return result;
  });

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
