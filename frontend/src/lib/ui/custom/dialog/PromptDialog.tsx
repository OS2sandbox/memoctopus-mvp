"use client";

import { LucideAlertCircle, LucidePencil, LucidePlus } from "lucide-react";

import { PROMPT_CATEGORY } from "@/lib/constants";
import { useCurrentUser } from "@/lib/hooks/use-current-user";
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
import { MAX_ASSET_NAME_LENGTH, MAX_PROMPT_LENGTH } from "@/shared/constants";
import type { Prompt, PromptDTO } from "@/shared/schemas/prompt";
import { validatePromptDTO } from "@/shared/utils";

import { Activity, type ReactNode, useState } from "react";

type PromptForm = {
  name: string;
  text: string;
  category: PROMPT_CATEGORY;
  isFavorite: boolean;
};

const DEFAULT_PROMPT = {
  name: "",
  text: "",
  category: PROMPT_CATEGORY.Beslutningsreferat,
  isFavorite: false,
};

// if editOpts is provided, the dialog will be in edit mode
interface PromptDialogProps {
  editOpts?: {
    initialPrompt: Prompt;
  };
  onSubmit: (data: PromptDTO, opts?: { promptId?: string }) => void;
  trigger?: ReactNode;
}

export const PromptDialog = ({
  editOpts,
  onSubmit,
  trigger,
}: PromptDialogProps) => {
  const { initialPrompt } = editOpts ?? {};

  const isEditMode = !!initialPrompt;
  const [prompt, setPrompt] = useState<PromptForm>(
    !isEditMode ? DEFAULT_PROMPT : initialPrompt,
  );
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] =
    useState<Record<string, string[]>>();

  const user = useCurrentUser();

  const PromptCategoryOptions = Object.values(PROMPT_CATEGORY);

  const updatePrompt = <K extends keyof PromptForm>(key: K, value: Prompt[K]) =>
    setPrompt((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = () => {
    const dto: PromptDTO = {
      ...prompt,
      creator: { id: user.id, name: user.name },
    };

    const { valid, errors, data } = validatePromptDTO({ data: dto });

    if (!valid) {
      setValidationErrors(errors);
      return;
    }

    onSubmit(data!, isEditMode ? { promptId: initialPrompt.id } : undefined);

    setValidationErrors({});
    setError(null);
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
            <Field data-invalid={!!validationErrors?.["name"]}>
              <div className="flex items-center justify-between">
                <FieldLabel>Titel</FieldLabel>
                <span className="text-xs text-muted-foreground">
                  {prompt.name.trim().length}/{MAX_ASSET_NAME_LENGTH}
                </span>
              </div>
              <Input
                id="name"
                value={prompt.name}
                onChange={(e) => updatePrompt("name", e.target.value)}
                placeholder="F.eks. Statusmøde på Orto"
                required
              />
              {validationErrors?.["name"]?.[0] && (
                <p className="text-xs text-destructive mt-1">
                  {validationErrors["name"][0]}
                </p>
              )}
            </Field>

            <Field>
              <FieldLabel>Kategori</FieldLabel>
              <Select
                onValueChange={(c) =>
                  updatePrompt("category", c as PROMPT_CATEGORY)
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

            <Field data-invalid={!!validationErrors?.["text"]}>
              <div className="flex items-center justify-between">
                <FieldLabel>Prompt tekst</FieldLabel>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {prompt.text.trim().length}/{MAX_PROMPT_LENGTH}
                  </span>
                  <PromptHelpPanel />
                </div>
              </div>
              <Textarea
                id="text"
                value={prompt.text}
                onChange={(e) => updatePrompt("text", e.target.value)}
                placeholder="Skriv promptens indhold her..."
                className="min-h-[120px]"
                required
              />
              {validationErrors?.["text"]?.[0] && (
                <p className="text-xs text-destructive mt-1">
                  {validationErrors["text"][0]}
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
