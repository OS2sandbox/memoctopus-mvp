import { defineStepper } from "@/components/ui/core/shadcn/stepper";

export const { Stepper, utils } = defineStepper(
  {
    id: "step-1",
    title: "Tale",
    description: "Optag eller upload tale",
  },
  {
    id: "step-2",
    title: "Prompt",
    description: "Tilføj prompt og opsæt detaljer",
  },
  {
    id: "step-3",
    title: "Godkend",
    description: "Gennemgå og godkend indholdet",
  },
  { id: "step-4", title: "Del", description: "Del eller download resultatet" },
);
