"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createPrompt, updatePrompt, deletePrompt } from "@/lib/api/prompts";
import { DATA_TABLE_SCOPE } from "@/lib/constants";
import { useCurrentUser } from "@/lib/hooks/use-current-user";
import type { PromptTableProps } from "@/lib/ui/custom/prompt-library/table/PromptTable";
import type { Prompt } from "@/shared/schemas/prompt";

import { useState } from "react";

export const usePromptTable = ({
  tableMode,
  data,
}: Omit<PromptTableProps, "className" | "hideAddButton" | "isProcessing">) => {
  const user = useCurrentUser();
  const queryClient = useQueryClient();

  const [scope, setScope] = useState<DATA_TABLE_SCOPE | null>(null);

  // Mutation for creating prompts
  const createMutation = useMutation({
    mutationFn: createPrompt,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });

  // Mutation for updating prompts
  const updateMutation = useMutation({
    mutationFn: ({ id, ...prompt }: Prompt) => updatePrompt(id, prompt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });

  // Mutation for deleting prompts
  const deleteMutation = useMutation({
    mutationFn: deletePrompt,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });

  const handleToggleFavorite = (id: string, checked: boolean) => {
    const prompt = data.find((p) => p.id === id);
    if (prompt) {
      updateMutation.mutate({ ...prompt, isFavorite: checked });
    }
  };

  const handleDeletePrompt = (id: string) => {
    deleteMutation.mutate(id);
  };

  const handleAddPrompt = (newPrompt: Omit<Prompt, "id">) => {
    createMutation.mutate(newPrompt);
  };

  const handleUpdatePrompt = (updatedPrompt: Prompt) => {
    updateMutation.mutate(updatedPrompt);
  };

  const filteredPrompts = data.filter((prompt) => {
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
