import { LucideMic } from "lucide-react";

import { Button } from "@/components/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@/components/core/shadcn/dialog";

/* TODO: Add recording functionality:
    - Integrate recording library
    - Implement wavesurfer library for audio visualization
    - Add controls for start, stop, pause, and playback (maybe not in MVP)
 */

interface RecordDialogProps {
  isRecordingDisabled?: boolean;
}
export const RecordDialog = ({
  isRecordingDisabled = false,
}: RecordDialogProps) => {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size={"lg"} disabled={isRecordingDisabled}>
          <LucideMic /> Optag
        </Button>
      </DialogTrigger>
      <DialogContent>Lorem ipsum dolor sit amet</DialogContent>
    </Dialog>
  );
};
