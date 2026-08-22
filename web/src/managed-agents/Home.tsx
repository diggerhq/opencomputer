import { FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import {
  Check,
  ChevronRight,
  Clipboard,
  FolderKanban,
  Loader2,
  Plus,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelContent } from '@/components/panel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { notifyError } from '@/lib/errors'
import { createManagedProject, getManagedProjects } from './api'
import { starterCommandBlock, starterCopyCommand } from './onboarding'

export default function ProjectsHome() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const [copied, setCopied] = useState(false)
  const projects = useQuery({
    queryKey: ['managed-projects'],
    queryFn: getManagedProjects,
  })
  const createProject = useMutation({
    mutationFn: createManagedProject,
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ['managed-projects'] })
      setDialogOpen(false)
      setName('')
      navigate(`/projects/${encodeURIComponent(project.id)}`)
    },
    onError: (error) => notifyError("Couldn't create the project.", error),
  })
  const items = projects.data ?? []

  function submit(event: FormEvent) {
    event.preventDefault()
    const value = name.trim()
    if (value) createProject.mutate(value)
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(starterCopyCommand('hello-world'))
      setCopied(true)
      toast.success('Command copied')
    } catch (error) {
      notifyError("Couldn't copy the command.", error)
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Projects"
        description="Choose a project to open its agent playground, deployments, sessions, and resources."
        actions={
          items.length > 0 ? (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus /> New project
            </Button>
          ) : undefined
        }
      />

      {projects.isLoading ? (
        <div className="flex min-h-64 items-center justify-center">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : projects.isError ? (
        <Panel>
          <EmptyState
            icon={FolderKanban}
            title="Your projects are temporarily unavailable"
            description="Try loading the projects page again."
            action={
              <Button variant="outline" onClick={() => void projects.refetch()}>
                Try again
              </Button>
            }
          />
        </Panel>
      ) : items.length === 0 ? (
        <div className="overflow-hidden rounded-xl border bg-[radial-gradient(circle_at_top_right,color-mix(in_oklch,var(--primary)_14%,transparent),transparent_45%)] px-6 py-10 sm:px-10">
          <div className="max-w-2xl">
            <div className="bg-primary/10 text-primary mb-4 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium">
              <Sparkles className="size-3.5" /> Your first project
            </div>
            <h2 className="text-3xl font-semibold tracking-tight">
              Create your first project
            </h2>
            <p className="text-muted-foreground mt-3 max-w-xl text-sm leading-6">
              Start with one hello-world agent. Your OpenComputer project is
              ready for more agents as it grows.
            </p>
            <pre className="bg-foreground text-background mt-5 overflow-x-auto rounded-lg px-4 py-3 text-sm leading-7">
              <code>{starterCommandBlock('hello-world')}</code>
            </pre>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button onClick={() => setDialogOpen(true)}>
                <Plus /> Create project
              </Button>
              <Button variant="outline" onClick={() => void copyCommand()}>
                {copied ? <Check /> : <Clipboard />}
                {copied ? 'Copied' : 'Copy command'}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <section className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((project) => (
              <Link
                key={project.id}
                to={`/projects/${encodeURIComponent(project.id)}`}
                className="group focus-visible:ring-ring/50 rounded-lg outline-none focus-visible:ring-3"
              >
                <Panel className="group-hover:border-foreground/20 group-hover:bg-muted/25 h-full transition-colors">
                  <PanelContent className="flex items-center gap-3">
                    <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
                      <FolderKanban className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {project.name}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {project.agents.length}{' '}
                        {project.agents.length === 1 ? 'agent' : 'agents'} ·{' '}
                        {project.environments.length} environments
                      </p>
                    </div>
                    <ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" />
                  </PanelContent>
                </Panel>
              </Link>
            ))}
          </div>
        </section>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription>
              Projects can contain multiple agents and share channels, files,
              and schedules.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submit}>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My first project"
              aria-label="Project name"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!name.trim() || createProject.isPending}
              >
                {createProject.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Plus />
                )}
                Create project
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
