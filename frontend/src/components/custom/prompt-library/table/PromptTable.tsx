"use client";

import { DataTable } from "@/components/core/data-table";
import {
  getColumns,
  type Prompt,
} from "@/components/custom/prompt-library/table/Columns";

import { useState } from "react";

export const PromptTable = () => {
  const [prompts, setPrompts] = useState<Prompt[]>([
    {
      id: "1",
      name: "Festudvalget på orto",
      creator: { id: "123", name: "Party Lars" },
      category: "Beslutningsreferat",
      isFavorite: true,
      text: "Lav et beslutningsreferat for mødet afholdt den 12. marts 2024, hvor følgende punkter blev diskuteret: budgetgodkendelse, projektstatus og kommende arrangementer.",
    },
    {
      id: "2",
      name: "EPJ input - venter på API",
      creator: { id: "123", name: "Party Lars" },
      category: "API",
      isFavorite: false,
      text: "Lorem Ipsum Dolor Sit Amet",
    },
    {
      id: "3",
      name: "Festudvalget på Tarm",
      creator: { id: "1234", name: "Camilla Nielsen" },
      category: "To do liste",
      isFavorite: false,
      text: "Lorem Ipsum Dolor Sit Amet 2",
    },
  ]);

  const handleToggleFavorite = (id: string, checked: boolean) => {
    setPrompts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, isFavorite: checked } : p)),
    );
  };

  const columns = getColumns(handleToggleFavorite);

  const handleAddPrompt = (newPrompt: Prompt) => {
    setPrompts((prev) => [...prev, newPrompt]);
  };

  return (
    <section className="space-y-4 w-full max-w-5xl">
      <h2 className="text-2xl font-semibold">Prompt-bibliotek</h2>
      <DataTable columns={columns} data={prompts} onAdd={handleAddPrompt} />
    </section>
  );
};
