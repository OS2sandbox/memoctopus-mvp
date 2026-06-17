import { VisuallyHidden } from "@radix-ui/react-visually-hidden";

import { Button } from "@/lib/ui/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@/lib/ui/core/shadcn/dialog";

import { Activity, type ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  children: ReactNode;
  trigger?: ReactNode;
  footerOpts?: {
    footerDisabled?: boolean;
    confirmText?: string;
    cancelText?: string;
    isConfirmDestructive?: boolean;
  };
}

/**
 * A reusable confirmation dialog component.
 * Uses composition to render custom confirmation text inside `children`.
 */
export const ConfirmDialog = ({
  open,
  onOpenChange,
  onConfirm,
  children,
  trigger,
  footerOpts,
}: ConfirmDialogProps) => {
  const { footerDisabled, confirmText, isConfirmDestructive, cancelText } =
    footerOpts ?? {};

  return (
    <Dialog open={open} modal={false} onOpenChange={onOpenChange}>
      <Activity mode={trigger ? "visible" : "hidden"}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      </Activity>
      <DialogContent
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        showCloseButton={false}
      >
        <VisuallyHidden>
          <DialogTitle>Bekræft prompt-valg</DialogTitle>
        </VisuallyHidden>
        <div className="p-5 space-y-2">{children}</div>
        <DialogFooter>
          <Button
            disabled={footerDisabled}
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            {cancelText ? cancelText : "Annuller"}
          </Button>
          <Button
            disabled={footerDisabled}
            variant={isConfirmDestructive ? "destructive" : undefined}
            onClick={onConfirm}
          >
            {confirmText ? confirmText : "Godkend"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
