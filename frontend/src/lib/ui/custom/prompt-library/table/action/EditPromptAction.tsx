"use client";

import { LucidePencil } from "lucide-react";

import { Button } from "@/lib/ui/core/shadcn/button";
import { PromptDialog } from "@/lib/ui/custom/dialog/PromptDialog";
import type { Prompt, PromptDTO } from "@/shared/schemas/prompt";

interface EditPromptActionProps {
  prompt: Prompt;
  canEdit: boolean;
  onUpdate: (dto: PromptDTO) => void;
}

export const EditPromptAction = ({
  prompt,
  canEdit,
  onUpdate,
}: EditPromptActionProps) => {
  return (
    <PromptDialog
      editOpts={{ initialPrompt: prompt }}
      onSubmit={onUpdate}
      trigger={
        <Button disabled={!canEdit} variant="ghost">
          <LucidePencil />
        </Button>
      }
    />
  );
};
