import type { ReactNode } from "react";

import { Button } from "@/lib/ui/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from "@/lib/ui/core/shadcn/dialog";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  triggerLabel: string;
  triggerDisabled?: boolean;
  children: ReactNode;
}

/**
 * A reusable confirmation dialog component.
 * Uses composition to render custom confirmation text inside `children`.
 */
export const ConfirmDialog = ({
  open,
  onOpenChange,
  onConfirm,
  triggerLabel,
  triggerDisabled = false,
  children,
}: ConfirmDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogTrigger asChild>
      <Button disabled={triggerDisabled}>{triggerLabel}</Button>
    </DialogTrigger>

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
