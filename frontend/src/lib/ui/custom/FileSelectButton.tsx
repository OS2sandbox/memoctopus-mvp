"use client";

import { LucideCheck } from "lucide-react";

import { STEP_ID } from "@/lib/constants";
import { Button } from "@/lib/ui/core/shadcn/button";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";

import { Activity, type ChangeEvent, useRef } from "react";

interface FileSelectButtonProps {
  fileType?: string;
}

/**
 *
 * @param fileType - Optional string to specify the accepted file type *(e.g., "audio/*", "image/*")*.
 */
export const FileSelectButton = ({ fileType }: FileSelectButtonProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const currMetadata = useStepper().metadata[STEP_ID.UploadSpeechStep] ?? {};
  const currFile = currMetadata["file"] as File | undefined;

  const { setMetadata, metadata } = useStepper();
  const isUploaded = metadata[STEP_ID.UploadSpeechStep]?.[
    "isCompleted"
  ] as boolean;

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setMetadata(STEP_ID.UploadSpeechStep, { ...currMetadata, file });
    }
  };

  const handleClick = () => {
    inputRef.current?.click();
  };

  // This is NOT the actual upload logic, just a simulation; a placeholder.
  // TODO: insert upload logic here (backend)
  const handleUpload = () => {
    const currentMetadata = metadata[STEP_ID.UploadSpeechStep] ?? {};
    setMetadata(STEP_ID.UploadSpeechStep, {
      ...currentMetadata,
      isCompleted: true,
    });
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={fileType}
        onChange={handleFileChange}
        className="hidden"
      />

      <Button
        variant="outline"
        onClick={handleClick}
        disabled={isUploaded}
        className={currFile?.name ? "text-gray-500" : ""}
      >
        {currFile?.name ? currFile?.name : "Vælg fil"}
      </Button>

      <Activity mode={currFile ? "visible" : "hidden"}>
        <div className="flex flex-row gap-2 items-center">
          <Button onClick={handleUpload} disabled={isUploaded}>
            Anvend
          </Button>
          {isUploaded ? <LucideCheck className="text-green-500" /> : null}
        </div>
      </Activity>
    </div>
  );
};
