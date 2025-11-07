"use client";

import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";

import { DATA_TABLE_SCOPE, FILTER_MODE } from "@/lib/constants";
import type { Prompt } from "@/lib/schemas/prompt";
import { Button } from "@/lib/ui/core/shadcn/button";
import { Checkbox } from "@/lib/ui/core/shadcn/checkbox";
import { Input } from "@/lib/ui/core/shadcn/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/lib/ui/core/shadcn/table";
import { PromptDialog } from "@/lib/ui/custom/prompt-library/PromptDialog";

import { Activity, useState } from "react";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  onAdd?: (column: TData) => void;
  scopeOpts?: {
    onScopeChange: (scope: DATA_TABLE_SCOPE | null) => void;
    scope: DATA_TABLE_SCOPE | null;
    filterModes?: FILTER_MODE[];
  };
  onRowClick?: (entry: TData) => void;
}

// TODO: Must be made more generic to be reusable
export function DataTable<TData, TValue>({
  columns,
  data,
  onAdd,
  scopeOpts,
  onRowClick,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const { onScopeChange, scope, filterModes } = scopeOpts ?? {};

  const toggleScope = (value: DATA_TABLE_SCOPE) => {
    const scopeValue = scope === value ? null : value;
    onScopeChange?.(scopeValue);
    table.getColumn("creator")?.setFilterValue(scopeValue);
  };

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-3">
          <Input
            placeholder="Søg efter prompt..."
            value={(table.getColumn("name")?.getFilterValue() as string) ?? ""}
            onChange={(e) =>
              table.getColumn("name")?.setFilterValue(e.target.value)
            }
            className="max-w-xs"
          />

          {scopeOpts && (
            <div className="flex flex-row gap-3">
              <p className="text-sm font-medium text-muted-foreground">
                Oprettet af:
              </p>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <Checkbox
                    checked={scope === DATA_TABLE_SCOPE.MyItems}
                    onCheckedChange={() =>
                      toggleScope(DATA_TABLE_SCOPE.MyItems)
                    }
                    disabled={filterModes?.includes(FILTER_MODE.Mine)}
                  />
                  <span>Mig</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <Checkbox
                    disabled={true}
                    checked={scope === DATA_TABLE_SCOPE.MyOrganization}
                    onCheckedChange={() =>
                      toggleScope(DATA_TABLE_SCOPE.MyOrganization)
                    }
                  />
                  <span>Min afdeling</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* TODO: Make this generic, then base it on type */}
        <Activity mode={onAdd ? "visible" : "hidden"}>
          <PromptDialog onSubmit={onAdd as (data: Prompt) => void} />
        </Activity>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={() => onRowClick?.(row.original)}
                  className={
                    onRowClick
                      ? "cursor-pointer hover:bg-muted/50 transition-colors"
                      : undefined
                  }
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  Ingen resultater fundet
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
        >
          Forrige
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
        >
          Næste
        </Button>
      </div>
    </div>
  );
}
