import type { RuleDefinition } from "@/lib/utils/regex-rule-formatter/types";

export const safeNameRules: readonly RuleDefinition[] = [
  {
    name: "normalizeUnicode",
    apply: ({ value: v }) => v.normalize("NFKD"),
  },
  {
    name: "replaceNonAlphanumeric",
    apply: ({ value: v }) => v.replace(/[^\p{L}\p{N}]+/gu, "-"),
  },
  {
    name: "trimHyphens",
    apply: ({ value: v }) => v.replace(/^-+|-+$/g, ""),
  },
  {
    name: "collapseHyphens",
    apply: ({ value: v }) => v.replace(/-+/g, "-"),
  },
  {
    name: "toLowerCase",
    apply: ({ value: v }) => v.toLowerCase(),
  },
];

export const htmlToTextRules: readonly RuleDefinition[] = [
  {
    name: "replaceLineBreaks",
    apply: ({ value: v }) => v.replace(/<br\s*\/?>/gi, "\n"),
  },
  {
    name: "removeHTMLTags",
    apply: ({ value: v }) => v.replace(/<[^>]+>/g, ""),
  },
  {
    name: "trimWhitespace",
    apply: ({ value: v }) => v.trim(),
  },
];
