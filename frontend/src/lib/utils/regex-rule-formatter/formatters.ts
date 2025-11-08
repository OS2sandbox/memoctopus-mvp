import {ruleFormatter} from "@/lib/utils/regex-rule-formatter/RuleFormatter";
import {RuleDefinition} from "@/lib/utils/regex-rule-formatter/types";

const safeNameRules: readonly RuleDefinition[] = [
    {
        name: "normalizeUnicode",
        apply: (v) => v.normalize("NFKD"),
    },
    {
        name: "replaceNonAlphanumeric",
        apply: (v) => v.replace(/[^\p{L}\p{N}]+/gu, "-"),
    },
    {
        name: "trimHyphens",
        apply: (v) => v.replace(/^-+|-+$/g, ""),
    },
    {
        name: "collapseHyphens",
        apply: (v) => v.replace(/-+/g, "-"),
    },
    {
        name: "toLowerCase",
        apply: (v) => v.toLowerCase(),
    },
];

interface SafeNameProps {
    fileName: string;
}

export const formatToSafeFileName = ({ fileName }: SafeNameProps): string => {
    const composeResult = ruleFormatter({
        value: fileName,
        rules: safeNameRules,
    });

    return composeResult;
};