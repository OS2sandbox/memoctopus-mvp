import { Button } from "@/lib/ui/core/shadcn/button";
import { MinimalTiptap } from "@/lib/ui/core/shadcn/minimal-tiptap";
import { ConfirmDialog } from "@/lib/ui/custom/dialog/ConfirmDialog";
import { getVisibleTextLength } from "@/lib/utils/utils";
import { MAX_TRANSCRIPT_LENGTH } from "@/shared/constants";

import { useState } from "react";

interface SummaryEditorProps {
  initialContent?: string;
  onApprove: (markdown: string) => void;
  disabled?: boolean;
}

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
        charLimit={MAX_TRANSCRIPT_LENGTH}
      />
      <div className="flex justify-end gap-2 pt-4">
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          onConfirm={handleApprove}
          trigger={<Button disabled={triggerDisabled}>Godkend</Button>}
        >
          <p>Er du sikker på, at du vil godkende dette resumé?</p>
          <p>Idet du godkender, kan du ikke redigere yderligere.</p>
        </ConfirmDialog>
      </div>
    </div>
  );
};
