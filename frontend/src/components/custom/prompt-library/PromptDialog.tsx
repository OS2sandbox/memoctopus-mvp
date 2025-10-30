// 'frontend/src/components/custom/prompt-library/AddPromptDialog.tsx'
"use client";

import { LucideAlertCircle, LucidePencil, LucidePlus } from "lucide-react";

import { Alert, AlertTitle } from "@/components/core/shadcn/alert";
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
import {
  type Prompt,
  PromptCategory,
} from "@/components/custom/prompt-library/table/Columns";
import { type User, useSession } from "@/lib/auth-client";

import { Activity, type ReactNode, useState } from "react";

const DEFAULT_PROMPT: Prompt = {
  id: "",
  name: "",
  text: "",
  category: PromptCategory.Beslutningsreferat,
  creator: { id: "", name: "" },
  isFavorite: false,
};

// if editOpts is provided, the dialog will be in edit mode
interface PromptDialogProps {
  editOpts?: {
    initialPrompt: Prompt;
  };
  onSubmit: (data: Prompt) => void;
  trigger?: ReactNode;
}

// TODO: Make the dialog required and validate the fields

/**
 *
 * @param editOpts - Optional editing options; **if provided, the dialog operates in edit mode.**
 * @param onSubmit - Callback function invoked upon form submission with the prompt data.
 * @param trigger - Optional custom trigger element for opening the dialog, overriding the default button.
 * @returns A PromptDialog component for creating or editing prompts.
 */
export const PromptDialog = ({
  editOpts,
  onSubmit,
  trigger,
}: PromptDialogProps) => {
  const { initialPrompt } = editOpts || {};

  const isEditMode = !!initialPrompt;
  const [prompt, setPrompt] = useState<Prompt>(initialPrompt ?? DEFAULT_PROMPT);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: session } = useSession();
  const user = session?.user as User | null;
  const PromptCategoryOptions = Object.values(PromptCategory);

  const validatePrompt = (p: Prompt): string | null => {
    if (!p.name.trim() || !p.text.trim()) {
      return "Tekstfelter kan ikke være tomme.";
    }
    return null;
  };

  const handleSubmit = () => {
    const validationError = validatePrompt(prompt);
    if (validationError) {
      setError(validationError);
      return;
    }

    const id = isEditMode ? prompt.id : Math.random().toString(36).slice(2);

    const newPrompt: Prompt = {
      ...prompt,
      id,
      creator: {
        id: user?.id ?? "",
        name: user?.name ?? "",
      },
    };

    onSubmit(newPrompt);
    setError(null);
    setOpen(false);
    if (!isEditMode) setPrompt(DEFAULT_PROMPT);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant={isEditMode ? "secondary" : "default"}>
            {isEditMode ? <LucidePencil /> : <LucidePlus />}
            {isEditMode ? "Rediger prompt" : "Tilføj prompt"}
          </Button>
        )}
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? "Rediger prompt" : "Opret ny prompt"}
          </DialogTitle>
        </DialogHeader>

        <FieldSet>
          <FieldGroup className="flex flex-col gap-4">
            <Field data-invalid={!!error && !prompt.name.trim()}>
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
                  setPrompt((prev) => ({
                    ...prev,
                    category: c as PromptCategory,
                  }))
                }
                value={prompt.category}
              >
                <SelectTrigger id="category">
                  <SelectValue placeholder="Vælg kategori" />
                </SelectTrigger>
                <SelectContent>
                  {PromptCategoryOptions.map((category) => (
                    <SelectItem key={category} value={category}>
                      {category}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field data-invalid={!!error && !prompt.text.trim()}>
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

        <DialogFooter className="sm:justify-between">
          <div className="mr-auto">
            <Activity mode={error ? "visible" : "hidden"}>
              <Alert
                variant="destructive"
                className="p-0 px-2 py-1.5 justify-start items-center w-fit"
              >
                <LucideAlertCircle className="mb-1" />
                <AlertTitle>{error}</AlertTitle>
              </Alert>
            </Activity>
          </div>

          <Button onClick={handleSubmit} disabled={!user || !user.id}>
            {isEditMode ? "Gem ændringer" : "Tilføj"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
