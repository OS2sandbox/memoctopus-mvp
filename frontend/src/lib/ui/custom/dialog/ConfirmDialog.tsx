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
  footerDisabled?: boolean;
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
  footerDisabled,
}: ConfirmDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
            Annuller
          </Button>
          <Button disabled={footerDisabled} onClick={onConfirm}>
            Godkend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
