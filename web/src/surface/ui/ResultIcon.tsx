import type { ReactNode } from 'react'
import type { ResultRow } from '@opencomputer/sdk/computer'
import { I } from './icons'
import { Mk } from './Mark'

const ICON: Record<string, ReactNode> = {
  pr: I.pr,
  changes: I.files,
  preview: I.globe,
  file: I.doc,
  document: I.doc,
}

// A result's icon; the ring instead while it is what the thread waits on (R20).
export function ResultIcon({
  result,
  ring,
}: {
  result: ResultRow
  ring?: boolean
}) {
  return ring ? (
    <span className="inline-flex size-3.5 flex-none items-center justify-center">
      <Mk mark="ready" />
    </span>
  ) : (
    <span className="text-muted-foreground inline-flex flex-none">
      {ICON[result.type] ?? I.doc}
    </span>
  )
}
