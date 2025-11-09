"use client";

import { type DATA_TABLE_SCOPE, FILTER_MODE } from "@/lib/constants";
import type { Prompt } from "@/lib/schemas/prompt";
import type { PromptTableProps } from "@/lib/ui/custom/prompt-library/table/PromptTable";

import { useState } from "react";

export const usePromptTable = ({
  currentUser,
  tableMode,
  data,
}: Omit<PromptTableProps, "className" | "hideAddButton" | "isProcessing">) => {
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
        case FILTER_MODE.Mine:
          return prompt.creator.id === currentUser?.id;

        case FILTER_MODE.Favorites:
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
