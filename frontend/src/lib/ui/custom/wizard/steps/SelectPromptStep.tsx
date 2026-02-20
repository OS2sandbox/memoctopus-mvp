import { useQuery } from "@tanstack/react-query";

import { getPrompts } from "@/lib/api/prompts";
import { DATA_TABLE_SCOPE, STEP_ID } from "@/lib/constants";
import type { Prompt } from "@/lib/schemas/prompt";
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { PromptTable } from "@/lib/ui/custom/prompt-library/table/PromptTable";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";

export const SelectPromptStep = () => {
  const { metadata, setMetadata } = useStepper();
  const selectPromptMetadata = metadata[STEP_ID.SelectPromptStep] ?? {};
  const selectedPrompt: Prompt | undefined = selectPromptMetadata["prompt"];

  const { data: prompts, status } = useQuery({
    queryKey: ["prompts"],
    queryFn: getPrompts,
  });

  const handleOnRowClick = (entry: Prompt) => {
    setMetadata(STEP_ID.SelectPromptStep, {
      ...selectPromptMetadata,
      prompt: entry,
      isCompleted: true,
    });
  };

  const renderContent = () => {
    switch (status) {
      case "error":
        return <p>Der opstod en fejl ved hentning af skabeloner.</p>;
      case "pending": {
        return <Spinner />;
      }
      case "success": {
        return (
          <PromptTable
            data={prompts}
            hideAddButton={true}
            rowClickConfig={{
              onRowClick: handleOnRowClick,
              selectedPromptId: selectedPrompt?.id,
            }}
            tableMode={[DATA_TABLE_SCOPE.MyFavorites, DATA_TABLE_SCOPE.MyItems]}
          />
        );
      }
      default:
        return null;
    }
  };

  return <WizardPanel>{renderContent()}</WizardPanel>;
};
