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

import { Button } from "@/components/core/shadcn/button";
import { Checkbox } from "@/components/core/shadcn/checkbox";
import { Input } from "@/components/core/shadcn/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/core/shadcn/table";
import { PromptDialog } from "@/components/custom/prompt-library/PromptDialog";
import type { Prompt } from "@/components/custom/prompt-library/table/Columns";

import { useState } from "react";

export enum DataTableScope {
  MyItems = "my_items",
  MyOrganization = "my_organization",
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  onAdd?: (column: TData) => void;
  scopeOpts?: {
    onScopeChange: (scope: DataTableScope | null) => void;
    scope: DataTableScope | null;
  };
}

// TODO: Must be made more generic to be reusable
export function DataTable<TData, TValue>({
  columns,
  data,
  onAdd,
  scopeOpts,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const { onScopeChange, scope } = scopeOpts ?? {};

  const toggleScope = (value: DataTableScope) => {
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
                    checked={scope === DataTableScope.MyItems}
                    onCheckedChange={() => toggleScope(DataTableScope.MyItems)}
                  />
                  <span>Mig</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <Checkbox
                    disabled={true}
                    checked={scope === DataTableScope.MyOrganization}
                    onCheckedChange={() =>
                      toggleScope(DataTableScope.MyOrganization)
                    }
                  />
                  <span>Min afdeling</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Add prompt button */}
        {onAdd && <PromptDialog onSubmit={onAdd as (data: Prompt) => void} />}
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
                <TableRow key={row.id}>
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
