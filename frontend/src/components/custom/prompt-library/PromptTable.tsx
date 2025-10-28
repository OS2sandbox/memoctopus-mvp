"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/core/shadcn/table";

// Maybe createdAt and updatedAt later
interface Prompt {
  id: string;
  name: string;
  creator: string;
  category: string; // enum ideally
  isFavorite: boolean;
  canEdit: boolean;
}

import { Eye, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/core/shadcn/button";
import { Switch } from "@/components/core/shadcn/switch";

import { useState } from "react";

export const PromptTable = () => {
  // dummy data
  const [prompts, setPrompts] = useState<Prompt[]>([
    {
      id: "1",
      name: "Festudvalget på orto",
      creator: "Party Lars",
      category: "Beslutningsreferat",
      isFavorite: true,
      canEdit: true,
    },
    {
      id: "2",
      name: "EPJ input - venter på API",
      creator: "Party Lars",
      category: "API",
      isFavorite: false,
      canEdit: true,
    },
    {
      id: "3",
      name: "Festudvalget på Tarm",
      creator: "Camilla Nielsen",
      category: "To do liste",
      isFavorite: false,
      canEdit: false,
    },
  ]);

  const handleToggleFavorite = (id: string, checked: boolean) => {
    setPrompts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, isFavorite: checked } : p)),
    );
  };

  return (
    <div className="border rounded-md">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[80px]">Tilføj/fjern</TableHead>
            <TableHead>Prompt</TableHead>
            <TableHead>Oprettet af</TableHead>
            <TableHead>Kategori</TableHead>
            <TableHead className="text-center">Se</TableHead>
            <TableHead className="text-center">Rediger</TableHead>
            <TableHead className="text-center">Slet</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {prompts.map((prompt) => (
            <TableRow key={prompt.id}>
              <TableCell>
                <Switch
                  checked={prompt.isFavorite}
                  onCheckedChange={(checked) =>
                    handleToggleFavorite(prompt.id, checked)
                  }
                />
              </TableCell>
              <TableCell className="font-medium">{prompt.name}</TableCell>
              <TableCell>{prompt.creator}</TableCell>
              <TableCell>{prompt.category}</TableCell>
              <TableCell className="text-center">
                <Button variant="ghost" size="icon">
                  <Eye className="h-4 w-4" />
                </Button>
              </TableCell>
              <TableCell className="text-center">
                {prompt.canEdit && (
                  <Button variant="ghost" size="icon">
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
              </TableCell>
              <TableCell className="text-center">
                {prompt.canEdit && (
                  <Button variant="ghost" size="icon">
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
