import { Button } from "@/lib/ui/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from "@/lib/ui/core/shadcn/dialog";

import { Activity, type ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  children: ReactNode;
  trigger?: ReactNode;
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
}: ConfirmDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Activity mode={trigger ? "visible" : "hidden"}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      </Activity>
      <DialogContent showCloseButton={false}>
        <div className="p-5 space-y-2">{children}</div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuller
          </Button>
          <Button onClick={onConfirm}>Godkend</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
