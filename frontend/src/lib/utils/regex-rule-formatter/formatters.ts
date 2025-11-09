import { ruleFormatter } from "@/lib/utils/regex-rule-formatter/RuleFormatter";
import type { RuleDefinition } from "@/lib/utils/regex-rule-formatter/types";

interface ComposeFormatRules {
  content: string;
  rules: readonly RuleDefinition[];
}

export const composeFormatRules = ({
  content,
  rules,
}: ComposeFormatRules): string => {
  const composeResult = ruleFormatter({
    value: content,
    rules: rules,
  });

  return composeResult;
};
