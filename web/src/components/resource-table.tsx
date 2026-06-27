import { Fragment, type ReactNode } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export type Column<T> = {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  align?: 'left' | 'right' | 'center'
  className?: string
  headClassName?: string
}

function alignClass(a?: 'left' | 'right' | 'center') {
  return a === 'right'
    ? 'text-right'
    : a === 'center'
      ? 'text-center'
      : 'text-left'
}

/**
 * Presentational table (replaces the hand-rolled .data-table). Column-config
 * driven; handles loading (skeleton) and empty states. Pass `onRowClick` to make
 * the whole row activatable (keyboard-accessible); otherwise put an explicit
 * action in a column. A row action button should stopPropagation to avoid also
 * triggering the row.
 */
export function ResourceTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 5,
  empty,
  renderSubRow,
  onRowClick,
  className,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  loading?: boolean
  skeletonRows?: number
  empty?: ReactNode
  /** Optional expanded row rendered under a row when it returns a node. */
  renderSubRow?: (row: T) => ReactNode
  /** Make the whole row activatable (click + Enter/Space). */
  onRowClick?: (row: T) => void
  className?: string
}) {
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((col) => (
              <TableHead
                key={col.key}
                className={cn(alignClass(col.align), col.headClassName)}
              >
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: skeletonRows }).map((_, i) => (
              <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                {columns.map((col) => (
                  <TableCell key={col.key} className={alignClass(col.align)}>
                    <Skeleton className="h-4 w-full max-w-[140px]" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const sub = renderSubRow?.(row)
              return (
                <Fragment key={rowKey(row)}>
                  <TableRow
                    className={cn(
                      'hover:bg-row-hover',
                      onRowClick && 'cursor-pointer',
                      sub && 'border-b-0',
                    )}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    role={onRowClick ? 'button' : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onRowClick(row)
                            }
                          }
                        : undefined
                    }
                  >
                    {columns.map((col) => (
                      <TableCell
                        key={col.key}
                        className={cn(alignClass(col.align), col.className)}
                      >
                        {col.cell(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                  {sub ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={columns.length} className="p-0">
                        {sub}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              )
            })
          )}
        </TableBody>
      </Table>
    </div>
  )
}
