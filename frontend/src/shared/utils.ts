import { z } from "zod";

import { type PromptDTO, PromptDTOSchema } from "@/shared/schemas/prompt";

interface ValidatePromptDtoProps {
  data: PromptDTO;
}

export type ValidationResult = {
  valid: boolean;
  errors: Record<string, string[]>;
  data?: PromptDTO;
};

export const validatePromptDTO = ({
  data,
}: ValidatePromptDtoProps): ValidationResult => {
  const result = PromptDTOSchema.safeParse(data);

  if (!result.success) {
    return {
      valid: false,
      errors: z.flattenError(result.error).fieldErrors,
    };
  }

  return {
    valid: true,
    errors: {},
    data: result.data,
  };
};
