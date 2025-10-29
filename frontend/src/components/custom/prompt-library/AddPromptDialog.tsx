// 'frontend/src/components/custom/prompt-library/AddPromptDialog.tsx'
"use client";

import { LucidePlus } from "lucide-react";

import { Button } from "@/components/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/core/shadcn/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/core/shadcn/field";
import { Input } from "@/components/core/shadcn/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/core/shadcn/select";
import { Textarea } from "@/components/core/shadcn/textarea";
import type { Prompt } from "@/components/custom/prompt-library/table/Columns";
import { type User, useSession } from "@/lib/auth-client";

import { useState } from "react";

const DEFAULT_PROMPT: Prompt = {
  id: "",
  name: "",
  text: "",
  category: "",
  creator: { id: "", name: "" },
  isFavorite: false,
};

interface AddPromptDialogProps {
  onAdd: (data: Prompt) => void;
}

// TODO: Make the dialog required and validate the fields

export const AddPromptDialog = ({ onAdd }: AddPromptDialogProps) => {
  const [prompt, setPrompt] = useState<Prompt>(DEFAULT_PROMPT);
  const [open, setOpen] = useState<boolean>(false);

  const { data: session } = useSession();
  const user = session?.user as User | null;

  const handleAdd = () => {
    const id = Math.random().toString(36).slice(2);

    const newPrompt: Prompt = {
      ...prompt,
      id,
      creator: {
        id: user.id,
        name: user.name,
      },
    };

    console.log("Adding prompt:", newPrompt);
    onAdd(newPrompt);
    setOpen(false);
    setPrompt(DEFAULT_PROMPT);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <LucidePlus />
          Tilføj prompt
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Opret ny prompt</DialogTitle>
        </DialogHeader>

        <FieldSet>
          <FieldGroup className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Titel</FieldLabel>
              <Input
                id="name"
                value={prompt.name}
                onChange={(e) =>
                  setPrompt((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="F.eks. Statusmøde på Orto"
                required
              />
            </Field>

            <Field>
              <FieldLabel>Kategori</FieldLabel>
              <Select
                onValueChange={(c) =>
                  setPrompt((prev) => ({ ...prev, category: c }))
                }
                value={prompt.category}
              >
                <SelectTrigger id="category">
                  <SelectValue placeholder="Vælg kategori" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="møde">Mødereferat</SelectItem>
                  <SelectItem value="api">API input</SelectItem>
                  <SelectItem value="beslutning">Beslutningsreferat</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel>Prompt tekst</FieldLabel>
              <Textarea
                id="text"
                value={prompt.text}
                onChange={(e) =>
                  setPrompt((prev) => ({ ...prev, text: e.target.value }))
                }
                placeholder="Skriv promptens indhold her..."
                className="min-h-[120px]"
                required
              />
            </Field>
          </FieldGroup>
        </FieldSet>

        <DialogFooter>
          <Button onClick={handleAdd} disabled={!user || !user.id}>
            Tilføj
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
