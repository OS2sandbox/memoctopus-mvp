import { useQuery } from "@tanstack/react-query";

import { getPrompts } from "@/lib/api/prompts";
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { PromptTable } from "@/lib/ui/custom/prompt-library/table/PromptTable";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";

export const SelectPromptStep = () => {
  const { data, status } = useQuery({
    queryKey: ["prompts"],
    queryFn: getPrompts,
  });

  // TODO: Repeated code. This should definitely be a hook
  const renderContent = () => {
    switch (status) {
      case "error":
        return <p>Der opstod en fejl ved hentning af prompts.</p>;
      case "pending":
        return <Spinner />;
      case "success":
        return <PromptTable data={data} />;
      default:
        return null;
    }
  };

  return <WizardPanel>{renderContent()}</WizardPanel>;
};
