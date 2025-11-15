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

import { DATA_TABLE_SCOPE } from "@/lib/constants";
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
import { cn } from "@/lib/utils/utils";

import { type ReactNode, useState } from "react";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  onRowClick?: (entry: TData) => void;
  addButtonConfig?: {
    addButton: ReactNode;
    onlyIfSearchEmpty?: boolean;
  };
  scopeOpts?: {
    onScopeChange: (scope: DATA_TABLE_SCOPE | null) => void;
    scope: DATA_TABLE_SCOPE | null;
    scopeModes?: DATA_TABLE_SCOPE[];
  };
  searchConfig?: {
    placeholder?: string;
    filterKey: keyof TData;
  };
  className?: string;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  addButtonConfig,
  scopeOpts,
  onRowClick,
  className,
  searchConfig,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const { onScopeChange, scope, scopeModes } = scopeOpts ?? {};
  const { filterKey, placeholder } = searchConfig ?? {};
  const { addButton, onlyIfSearchEmpty } = addButtonConfig ?? {};

  const toggleScope = (value: DATA_TABLE_SCOPE) => {
    const scopeValue = scope === value ? null : value;
    onScopeChange?.(scopeValue);
    table.getColumn("creator")?.setFilterValue(scopeValue);
  };

  const shouldIgnoreRowClick = (target: HTMLElement) => {
    const result = target.closest(
      "button, a, input, [role='button'], [data-row-action]",
    );
    return result;
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
    <div className={cn("space-y-4 w-full", className)}>
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-3">
          {searchConfig && typeof filterKey === "string" && (
            <Input
              placeholder={placeholder}
              value={
                (table.getColumn(filterKey)?.getFilterValue() as string) ?? ""
              }
              onChange={(e) =>
                table.getColumn(filterKey)?.setFilterValue(e.target.value)
              }
              className="max-w-xs"
            />
          )}

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
                    disabled={scopeModes?.includes(DATA_TABLE_SCOPE.MyItems)}
                  />
                  <span>Mig</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <Checkbox
                    disabled={true} // microsoft entra not implemented yet
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
        {!onlyIfSearchEmpty ? addButton : null}
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
                  onClick={(e) => {
                    const target = e.target as HTMLElement;

                    if (shouldIgnoreRowClick(target)) return;

                    onRowClick?.(row.original);
                  }}
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
                  className="h-12 text-center  text-gray-500"
                >
                  <div className={"flex flex-col items-center pb-2 pt-2 gap-3"}>
                    Ingen resultater fundet.
                    {addButton}
                  </div>
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
