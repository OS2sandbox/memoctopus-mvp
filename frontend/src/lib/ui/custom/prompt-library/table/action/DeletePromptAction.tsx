"use client";

import { LucideTrash2 } from "lucide-react";

import { Button } from "@/lib/ui/core/shadcn/button";
import { ConfirmDialog } from "@/lib/ui/custom/dialog/ConfirmDialog";

import { useState } from "react";

interface DeletePromptActionProps {
  canDelete: boolean;
  onDelete: () => void;
}

export const DeletePromptAction = ({
  canDelete,
  onDelete,
}: DeletePromptActionProps) => {
  const [open, setOpen] = useState(false);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      onConfirm={onDelete}
      trigger={
        <span className="inline-flex">
          <Button variant="ghost" size="icon" disabled={!canDelete}>
            <LucideTrash2 />
          </Button>
        </span>
      }
      footerOpts={{ isConfirmDestructive: true }}
    >
      <p>Er du sikker, at du vil slette denne prompt?</p>
      <p>Idet du bekræfter, kan du ikke tilbagekalde prompten.</p>
    </ConfirmDialog>
  );
};
