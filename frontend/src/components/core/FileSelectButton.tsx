"use client";

import {
  LucideAlertCircle,
  LucideCheck,
  LucideLoaderCircle,
} from "lucide-react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/core/shadcn/alert";
import { Button } from "@/components/core/shadcn/button";
import { StepId, useStepper } from "@/components/custom/wizard/stepper";

import { Activity, type ChangeEvent, useRef, useState } from "react";

interface FileSelectButtonProps {
  fileType?: string;
}

/**
 *
 * @param fileType - Optional string to specify the accepted file type *(e.g., "audio/*", "image/*")*.
 */
export const FileSelectButton = ({ fileType }: FileSelectButtonProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const { setMetadata, metadata } = useStepper();
  const isUploaded = metadata[StepId.UploadSpeechStep]?.[
    "isCompleted"
  ] as boolean;

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setMetadata(StepId.UploadSpeechStep, { ...selectedFile, file });
    }
  };

  const handleClick = () => {
    inputRef.current?.click();
  };

  // This is NOT the actual upload logic, just a simulation; a placeholder.
  // TODO: insert upload logic here (backend)
  const handleUpload = () => {
    setIsUploading(true);
    setUploadError(null);

    const fakeUploadTime = Math.random() * 2000 + 1500;
    const shouldFail = Math.random() < 0.3; // 30% chance to fail

    window.setTimeout(() => {
      try {
        setIsUploading(false);

        if (shouldFail) {
          throw new Error("Network error: could not upload file.");
        }

        const currentMetadata = metadata[StepId.UploadSpeechStep] ?? {};
        setMetadata(StepId.UploadSpeechStep, {
          ...currentMetadata,
          isCompleted: true,
        });
      } catch (error) {
        setUploadError(
          "Error occurred while uploading: " +
            (error instanceof Error ? error.message : "Unknown error"),
        );
      }
    }, fakeUploadTime);
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
        className={selectedFile?.name ? "text-gray-500" : ""}
      >
        {selectedFile?.name ? selectedFile?.name : "Vælg fil"}
      </Button>

      <Activity mode={uploadError ? "visible" : "hidden"}>
        <Alert variant="destructive">
          <LucideAlertCircle />
          <AlertTitle>Upload failed</AlertTitle>
          <AlertDescription>{uploadError}</AlertDescription>
        </Alert>
      </Activity>

      <Activity mode={selectedFile ? "visible" : "hidden"}>
        <div className="flex flex-row gap-2 items-center">
          <Button onClick={handleUpload} disabled={isUploaded}>
            Upload
          </Button>

          {isUploading ? (
            <LucideLoaderCircle className="animate-spin" />
          ) : isUploaded ? (
            <LucideCheck className="text-green-500" />
          ) : null}
        </div>
      </Activity>
    </div>
  );
};
