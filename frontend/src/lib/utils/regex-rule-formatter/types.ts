interface TransformRuleProps {
  value: string;
}

export type TransformRule = ({ value }: TransformRuleProps) => string;

export interface RuleDefinition {
  name: string;
  apply: TransformRule;
}
