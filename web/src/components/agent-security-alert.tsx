import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  acknowledgeAgentSecurityNotification,
  listAgentSecurityNotifications,
  type AgentSecurityNotification,
} from '@/api/client'
import { Button } from '@/components/ui/button'

export function AgentSecurityAlert({
  alerts,
  acknowledging = false,
  acknowledgeFailed = false,
  onAcknowledge,
}: {
  alerts: AgentSecurityNotification[]
  acknowledging?: boolean
  acknowledgeFailed?: boolean
  onAcknowledge: (id: string) => void
}) {
  const alert = alerts[0]
  if (!alert) return null

  return (
    <div
      className="border-destructive/40 bg-status-error-bg text-destructive flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-8"
      role="alert"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 text-sm">
          <p className="font-semibold">
            {alerts.length === 1
              ? 'An Agent Hook URL was exposed and revoked.'
              : `${alerts.length} Agent Hook URLs were exposed and revoked.`}
          </p>
          <p className="text-destructive/80 mt-0.5">
            Review the affected Hook before reconnecting its sender.{' '}
            <Link
              to={`/agents/${encodeURIComponent(alert.agentId)}/settings?section=hooks`}
              className="font-medium underline underline-offset-2"
            >
              Review agent
            </Link>
          </p>
          {acknowledgeFailed ? (
            <p className="mt-1 font-medium">
              Could not acknowledge the alert. Try again.
            </p>
          ) : null}
        </div>
      </div>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        className="self-start sm:self-center"
        disabled={acknowledging}
        onClick={() => onAcknowledge(alert.id)}
      >
        {acknowledging ? 'Acknowledging…' : 'Acknowledge'}
      </Button>
    </div>
  )
}

export function AgentSecurityAlertBanner() {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ['agent-security-notifications'],
    queryFn: listAgentSecurityNotifications,
    retry: 2,
    refetchInterval: 30_000,
  })
  const acknowledge = useMutation({
    mutationFn: acknowledgeAgentSecurityNotification,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['agent-security-notifications'],
      })
    },
  })

  return (
    <AgentSecurityAlert
      alerts={data?.data ?? []}
      acknowledging={acknowledge.isPending}
      acknowledgeFailed={acknowledge.isError}
      onAcknowledge={(id) => acknowledge.mutate(id)}
    />
  )
}
