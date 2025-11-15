"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createPrompt, deletePrompt, updatePrompt } from "@/lib/api/prompts";
import { DATA_TABLE_SCOPE } from "@/lib/constants";
import { useCurrentUser } from "@/lib/hooks/use-current-user";
import type { PromptTableProps } from "@/lib/ui/custom/prompt-library/table/PromptTable";
import type { PromptDTO } from "@/shared/schemas/prompt";

import { useState } from "react";

export const usePromptTable = ({
  tableMode,
  data,
}: Omit<PromptTableProps, "className" | "hideAddButton" | "isProcessing">) => {
  const user = useCurrentUser();
  const queryClient = useQueryClient();

  const [scope, setScope] = useState<DATA_TABLE_SCOPE | null>(null);

  const createMutation = useMutation({
    mutationFn: createPrompt,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: PromptDTO }) =>
      updatePrompt(id, dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deletePrompt,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });

  const handleToggleFavorite = (id: string, checked: boolean) => {
    const prompt = data.find((p) => p.id === id);
    if (!prompt) return;

    const dto: PromptDTO = {
      name: prompt.name,
      text: prompt.text,
      category: prompt.category,
      creator: prompt.creator,
      isFavorite: checked,
    };

    updateMutation.mutate({ id, dto });
  };

  const handleDeletePrompt = (id: string) => {
    deleteMutation.mutate(id);
  };

  const handleAddPrompt = (dto: PromptDTO) => {
    createMutation.mutate(dto);
  };

  const handleUpdatePrompt = (id: string, dto: PromptDTO) => {
    updateMutation.mutate({ id, dto });
  };

  const filteredPrompts = data.filter((prompt) => {
    if (tableMode?.length === 0 || !tableMode) return true;

    return tableMode.some((mode) => {
      switch (mode) {
        case DATA_TABLE_SCOPE.MyItems:
          return prompt.creator.id === user?.id;
        case DATA_TABLE_SCOPE.MyFavorites:
          return prompt.isFavorite;
        default:
          return false;
      }
    });
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
