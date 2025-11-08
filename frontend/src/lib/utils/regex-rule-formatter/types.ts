export type TransformRule = (value: string) => string;

export interface RuleDefinition {
  name: string;
  apply: TransformRule;
}
