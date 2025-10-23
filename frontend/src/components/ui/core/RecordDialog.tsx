import { LucideMic } from "lucide-react";

import { Button } from "@/components/ui/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/core/shadcn/dialog";

/* TODO: Add recording functionality:
    - Integrate recording library
    - Implement wavesurfer library for audio visualization
    - Add controls for start, stop, pause, and playback (maybe not in MVP)
 */
export const RecordDialog = () => {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size={"lg"}>
          <LucideMic /> Optag
        </Button>
      </DialogTrigger>
      <DialogContent>Lorem ipsum dolor sit amet</DialogContent>
    </Dialog>
  );
};
