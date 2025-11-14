"use client";

import { LucideAlertCircle, LucidePencil, LucidePlus } from "lucide-react";

import { type User, useSession } from "@/lib/auth-client";
import { PROMPT_CATEGORY } from "@/lib/constants";
import { Alert, AlertTitle } from "@/lib/ui/core/shadcn/alert";
import { Button } from "@/lib/ui/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/lib/ui/core/shadcn/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/lib/ui/core/shadcn/field";
import { Input } from "@/lib/ui/core/shadcn/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/lib/ui/core/shadcn/select";
import { Textarea } from "@/lib/ui/core/shadcn/textarea";
import { PromptHelpPanel } from "@/lib/ui/custom/prompt-library/PromptHelpPanel";
import type { Prompt } from "@/shared/schemas/prompt";

import { Activity, type ReactNode, useState } from "react";

const DEFAULT_PROMPT: Prompt = {
  id: "",
  name: "",
  text: "",
  category: PROMPT_CATEGORY.Beslutningsreferat,
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
  const { initialPrompt } = editOpts ?? {};

  const isEditMode = !!initialPrompt;
  const [prompt, setPrompt] = useState<Prompt>(initialPrompt ?? DEFAULT_PROMPT);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: session } = useSession();
  const user = session?.user as User | null;
  const PromptCategoryOptions = Object.values(PROMPT_CATEGORY);

  const [validationErrors, setValidationErrors] = useState<{
    name?: string;
    text?: string;
  }>({});

  const validatePrompt = (p: Prompt): boolean => {
    const errors: { name?: string; text?: string } = {};
    const trimmedName = p.name.trim();
    const trimmedText = p.text.trim();

    if (trimmedName.length === 0) {
      errors.name = "Titel kan ikke være tom";
    } else if (trimmedName.length < 5) {
      errors.name = "Titel skal være mindst 5 tegn";
    } else if (trimmedName.length > 200) {
      errors.name = "Titel må ikke overstige 200 tegn";
    }

    if (trimmedText.length === 0) {
      errors.text = "Prompt tekst kan ikke være tom";
    } else if (trimmedText.length < 5) {
      errors.text = "Prompt tekst skal være mindst 5 tegn";
    } else if (trimmedText.length > 4000) {
      errors.text = "Prompt tekst må ikke overstige 4000 tegn";
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = () => {
    const isValid = validatePrompt(prompt);
    if (!isValid) {
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
    setValidationErrors({});
    setOpen(false);
    if (!isEditMode) setPrompt(DEFAULT_PROMPT);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen} modal={false}>
      <DialogTrigger asChild>
        <div data-row-action>
          {trigger ?? (
            <Button variant={isEditMode ? "secondary" : "default"}>
              {isEditMode ? <LucidePencil /> : <LucidePlus />}
              {isEditMode ? "Rediger prompt" : "Tilføj prompt"}
            </Button>
          )}
        </div>
      </DialogTrigger>

      <DialogContent data-row-action>
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? "Rediger prompt" : "Opret ny prompt"}
          </DialogTitle>
        </DialogHeader>

        <FieldSet>
          <FieldGroup className="flex flex-col gap-4">
            <Field data-invalid={!!validationErrors.name}>
              <div className="flex items-center justify-between">
                <FieldLabel>Titel</FieldLabel>
                <span className="text-xs text-muted-foreground">
                  {prompt.name.trim().length}/200
                </span>
              </div>
              <Input
                id="name"
                value={prompt.name}
                onChange={(e) =>
                  setPrompt((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="F.eks. Statusmøde på Orto"
                required
              />
              {validationErrors.name && (
                <p className="text-xs text-destructive mt-1">
                  {validationErrors.name}
                </p>
              )}
            </Field>

            <Field>
              <FieldLabel>Kategori</FieldLabel>
              <Select
                onValueChange={(c) =>
                  setPrompt((prev) => ({
                    ...prev,
                    category: c as PROMPT_CATEGORY,
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

            <Field data-invalid={!!validationErrors.text}>
              <div className="flex items-center justify-between">
                <FieldLabel>Prompt tekst</FieldLabel>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {prompt.text.trim().length}/4000
                  </span>
                  <PromptHelpPanel />
                </div>
              </div>
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
              {validationErrors.text && (
                <p className="text-xs text-destructive mt-1">
                  {validationErrors.text}
                </p>
              )}
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
