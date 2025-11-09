import { Button } from "@/lib/ui/core/shadcn/button";
import { MinimalTiptap } from "@/lib/ui/core/shadcn/minimal-tiptap";
import { ConfirmDialog } from "@/lib/ui/custom/dialog/ConfirmDialog";
import { getVisibleTextLength } from "@/lib/utils/utils";

import { useState } from "react";

interface SummaryEditorProps {
  initialContent?: string;
  onApprove: (html: string) => void;
  disabled?: boolean;
}

/* TODO:
 *  - Remove the "Godkend" button and handle it on "Næste" instead with a warning dialog
 */
export const SummaryEditor = ({
  initialContent = "",
  onApprove,
  disabled = false,
}: SummaryEditorProps) => {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState(initialContent);

  const handleApprove = () => {
    setOpen(false);
    onApprove(content);
  };

  const triggerDisabled =
    !content || getVisibleTextLength(content) <= 0 || disabled;

  return (
    <div className="space-y-4">
      <MinimalTiptap
        content={content}
        onChange={setContent}
        placeholder="Redigér dit resumé her..."
        editable={!disabled}
        className={disabled ? "bg-gray-100" : ""}
      />
      <div className="flex justify-end gap-2 pt-4">
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          onConfirm={handleApprove}
          trigger={<Button disabled={triggerDisabled}>Godkend</Button>}
        >
          <p>Er du sikker på, at du vil godkende dette resumé?</p>
          <p>Når du godkender, kan du ikke redigere det yderligere.</p>
        </ConfirmDialog>
      </div>
    </div>
  );
};
