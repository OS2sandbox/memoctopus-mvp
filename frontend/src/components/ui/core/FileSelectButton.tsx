"use client";

import { Button } from "@/components/ui/core/shadcn/button";

import { type ChangeEvent, useRef, useState } from "react";

interface FileSelectButtonProps {
  fileType?: string;
}

/**
 *
 * **fileType**: Optional string to specify the accepted file type (e.g., "audio/*", "image/*").
 */
export const FileSelectButton = ({ fileType }: FileSelectButtonProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setFileName(file.name);
      console.log("Selected file:", file);
    }
  };

  const handleClick = () => {
    inputRef.current?.click();
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

      <Button onClick={handleClick}>
        {fileName ? "Vælg en ny fil" : "Vælg fil"}
      </Button>

      {fileName && (
        <p className="text-sm text-muted-foreground">
          Valgt fil: <span className="font-medium">{fileName}</span>
        </p>
      )}
    </div>
  );
};
