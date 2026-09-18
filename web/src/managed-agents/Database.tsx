import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Database, Loader2, Play, RefreshCw } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { Textarea } from '@/components/form'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { ApiError } from '@/api/client'
import {
  queryManagedProjectDatabase,
  type ManagedDatabaseResult,
  type ManagedDatabaseValue,
} from './api'
import type { ProjectEnvironment } from './project-context'

const PAGE_SIZE = 50
const TABLES_SQL = `SELECT name, sql
FROM sqlite_master
WHERE type = 'table'
  AND name NOT LIKE 'sqlite_%'
ORDER BY name`
const MIGRATIONS_SQL = `SELECT name, checksum, applied_at
FROM _opencomputer_migrations
ORDER BY name`
const DEFAULT_QUERY = `SELECT name, type
FROM sqlite_master
WHERE type IN ('table', 'view')
ORDER BY name`

export function quoteDatabaseIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

export function isUnprovisionedDatabaseError(error: unknown) {
  return error instanceof ApiError && error.type === 'database_not_provisioned'
}

function displayValue(value: ManagedDatabaseValue) {
  if (value === null) return <span className="text-muted-foreground">NULL</span>
  const text = String(value)
  return (
    <span className="block max-w-96 truncate font-mono text-xs" title={text}>
      {text}
    </span>
  )
}

function ResultTable({ result }: { result: ManagedDatabaseResult }) {
  if (!result.columns.length) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        Query completed without returning columns.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {result.columns.map((column) => (
              <TableHead key={column} className="whitespace-nowrap">
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.length ? (
            result.rows.map((row, index) => (
              <TableRow key={index}>
                {result.columns.map((column) => (
                  <TableCell key={column}>
                    {displayValue(row[column] ?? null)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={result.columns.length}
                className="text-muted-foreground py-8 text-center"
              >
                No rows
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export function ManagedProjectDatabase({
  projectId,
  environment,
  deployed,
}: {
  projectId: string
  environment: ProjectEnvironment
  deployed: boolean
}) {
  const [selectedName, setSelectedName] = useState<string>()
  const [offset, setOffset] = useState(0)
  const [sql, setSql] = useState(DEFAULT_QUERY)
  const tables = useQuery({
    queryKey: ['managed-project-database-tables', projectId, environment],
    queryFn: () =>
      queryManagedProjectDatabase({ projectId, environment, sql: TABLES_SQL }),
    enabled: deployed,
  })
  const applicationTables = (tables.data?.rows ?? [])
    .map((row) => ({
      name: typeof row.name === 'string' ? row.name : '',
      schema: typeof row.sql === 'string' ? row.sql : '',
    }))
    .filter((table) => table.name && !table.name.startsWith('_opencomputer_'))
  const selectedTable =
    applicationTables.find((table) => table.name === selectedName) ??
    applicationTables[0]
  const rows = useQuery({
    queryKey: [
      'managed-project-database-rows',
      projectId,
      environment,
      selectedTable?.name,
      offset,
    ],
    queryFn: () =>
      queryManagedProjectDatabase({
        projectId,
        environment,
        sql: `SELECT * FROM ${quoteDatabaseIdentifier(selectedTable!.name)} LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      }),
    enabled: deployed && Boolean(selectedTable),
  })
  const migrations = useQuery({
    queryKey: ['managed-project-database-migrations', projectId, environment],
    queryFn: () =>
      queryManagedProjectDatabase({
        projectId,
        environment,
        sql: MIGRATIONS_SQL,
      }),
    enabled: deployed,
  })
  const customQuery = useMutation({
    mutationFn: (query: string) =>
      queryManagedProjectDatabase({ projectId, environment, sql: query }),
  })

  if (!deployed) {
    return (
      <Panel>
        <EmptyState
          icon={Database}
          title={`No ${environment} database yet`}
          description={`Deploy this project to ${environment} to provision its database and apply migrations.`}
        />
      </Panel>
    )
  }

  if (tables.isError && isUnprovisionedDatabaseError(tables.error)) {
    return (
      <Panel>
        <EmptyState
          icon={Database}
          title={`No ${environment} database yet`}
          description={`Redeploy this project to ${environment} to provision its database and apply migrations.`}
        />
      </Panel>
    )
  }

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Database</PanelTitle>
            <PanelDescription>
              Read-only tables and rows for this project&apos;s {environment}{' '}
              environment.
            </PanelDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void tables.refetch()
              if (selectedTable) void rows.refetch()
              void migrations.refetch()
            }}
          >
            <RefreshCw
              className={cn(
                (tables.isFetching || rows.isFetching) && 'animate-spin',
              )}
            />
            Refresh
          </Button>
        </PanelHeader>
        {tables.isError ? (
          <PanelContent>
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t load database tables</AlertTitle>
              <AlertDescription>{tables.error.message}</AlertDescription>
            </Alert>
          </PanelContent>
        ) : (
          <PanelContent className="grid gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium">Tables</p>
                <Badge variant="secondary">{applicationTables.length}</Badge>
              </div>
              <div className="space-y-1">
                {tables.isLoading ? (
                  <div className="text-muted-foreground flex items-center gap-2 py-2 text-sm">
                    <Loader2 className="size-4 animate-spin" /> Loading tables
                  </div>
                ) : applicationTables.length ? (
                  applicationTables.map((table) => (
                    <button
                      key={table.name}
                      type="button"
                      className={cn(
                        'w-full rounded-md px-2.5 py-2 text-left font-mono text-xs transition-colors',
                        selectedTable?.name === table.name
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                      onClick={() => {
                        setSelectedName(table.name)
                        setOffset(0)
                      }}
                    >
                      {table.name}
                    </button>
                  ))
                ) : (
                  <p className="text-muted-foreground py-2 text-sm">
                    No application tables
                  </p>
                )}
              </div>
            </div>
            <div className="min-w-0 space-y-4">
              {selectedTable ? (
                <>
                  <div>
                    <h3 className="font-mono text-sm font-semibold">
                      {selectedTable.name}
                    </h3>
                    <pre className="bg-muted/40 text-muted-foreground mt-2 overflow-x-auto rounded-md border p-3 text-xs leading-5">
                      <code>{selectedTable.schema}</code>
                    </pre>
                  </div>
                  {rows.isError ? (
                    <Alert variant="destructive">
                      <AlertTitle>Couldn&apos;t load rows</AlertTitle>
                      <AlertDescription>{rows.error.message}</AlertDescription>
                    </Alert>
                  ) : rows.data ? (
                    <>
                      <ResultTable result={rows.data} />
                      <div className="flex items-center justify-between">
                        <p className="text-muted-foreground text-xs">
                          {rows.data.rows.length
                            ? `Rows ${offset + 1}–${offset + rows.data.rows.length}`
                            : 'No rows on this page'}
                        </p>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={offset === 0}
                            onClick={() =>
                              setOffset(Math.max(0, offset - PAGE_SIZE))
                            }
                          >
                            Previous
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={rows.data.rows.length < PAGE_SIZE}
                            onClick={() => setOffset(offset + PAGE_SIZE)}
                          >
                            Next
                          </Button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-muted-foreground flex min-h-32 items-center justify-center gap-2 text-sm">
                      <Loader2 className="size-4 animate-spin" /> Loading rows
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </PanelContent>
        )}
      </Panel>

      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Migrations</PanelTitle>
            <PanelDescription>
              Applied schema migrations for {environment}.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent>
          {migrations.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t load migrations</AlertTitle>
              <AlertDescription>{migrations.error.message}</AlertDescription>
            </Alert>
          ) : migrations.data ? (
            <ResultTable result={migrations.data} />
          ) : (
            <div className="text-muted-foreground flex min-h-20 items-center justify-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" /> Loading migrations
            </div>
          )}
        </PanelContent>
      </Panel>

      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Read-only query</PanelTitle>
            <PanelDescription>
              Run one SELECT, WITH, or EXPLAIN statement. Results are bounded to
              200 rows.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="space-y-4">
          <Textarea
            aria-label="Read-only SQL query"
            className="min-h-28 font-mono text-xs"
            value={sql}
            onChange={(event) => setSql(event.target.value)}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!sql.trim() || customQuery.isPending}
              onClick={() => customQuery.mutate(sql)}
            >
              {customQuery.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Play />
              )}
              Run query
            </Button>
          </div>
          {customQuery.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Query failed</AlertTitle>
              <AlertDescription>{customQuery.error.message}</AlertDescription>
            </Alert>
          ) : customQuery.data ? (
            <ResultTable result={customQuery.data} />
          ) : null}
        </PanelContent>
      </Panel>
    </div>
  )
}
