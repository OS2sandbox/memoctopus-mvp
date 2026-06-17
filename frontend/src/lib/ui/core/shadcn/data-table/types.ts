import type { ReactElement } from "react";

export type TableAction<K extends string> = {
  key: K;
  component: ReactElement;
  tooltipText: string;
};
