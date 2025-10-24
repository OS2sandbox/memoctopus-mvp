import { defineStepper } from "@/components/ui/core/shadcn/stepper";

export const { Stepper, utils, useStepper } = defineStepper(
  {
    id: "step-1",
    title: "Tilføj tale",
    description: "Optag eller upload tale",
  },
  {
    id: "step-2",
    title: "Vælg prompt",
    description: "Tilføj prompt og opsæt detaljer",
  },
  {
    id: "step-3",
    title: "Rediger og godkend",
    description: "Gennemgå og godkend indholdet",
  },
  { id: "step-4", title: "Del", description: "Hvordan vil du dele teksten?" },
);
