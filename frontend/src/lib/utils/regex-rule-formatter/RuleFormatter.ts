import type { RuleDefinition } from "@/lib/utils/regex-rule-formatter/types";

interface RuleFormatterProps {
  value: string;
  rules: readonly RuleDefinition[];
}

export const ruleFormatter = ({ value, rules }: RuleFormatterProps): string => {
  const result = !value
    ? ""
    : rules.reduce((acc, rule) => rule.apply({ value: acc }), value);
  return result;
};
