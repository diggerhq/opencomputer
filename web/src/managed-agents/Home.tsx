import { FormEvent, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  FolderGit2,
  FolderKanban,
  Loader2,
  Plus,
  Rocket,
  Sparkles,
} from 'lucide-react'
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
import { getManagedProjects } from './api'
import {
  CURATED_TEMPLATES,
  HELLO_WORLD_TEMPLATE_REPOSITORY,
  templateDeployPath,
} from './templates'

type CreateStep = 'choose' | 'templates'

export default function ProjectsHome() {
  const navigate = useNavigate()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [createStep, setCreateStep] = useState<CreateStep>('choose')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const projects = useQuery({
    queryKey: ['managed-projects'],
    queryFn: getManagedProjects,
  })
  const items = projects.data ?? []

  function openCreate() {
    setCreateStep('choose')
    setRepositoryUrl('')
    setDialogOpen(true)
  }

  function openTemplate(url: string) {
    setDialogOpen(false)
    void navigate(templateDeployPath(url))
  }

  function submitRepository(event: FormEvent) {
    event.preventDefault()
    const url = repositoryUrl.trim()
    if (url) openTemplate(url)
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Projects"
        description="Choose a project to open its agent playground, deployments, sessions, and resources."
        actions={
          items.length > 0 ? (
            <Button onClick={openCreate}>
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
              Create your first agent
            </h2>
            <p className="text-muted-foreground mt-3 max-w-xl text-sm leading-6">
              Start from a ready-to-run Hello World or choose an example. We’ll
              deploy it and open its first Debug session.
            </p>
            <div className="mt-6">
              <Button onClick={openCreate}>
                <Plus /> Create project
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
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {createStep === 'choose'
                ? 'Create project'
                : 'Start from a template'}
            </DialogTitle>
            <DialogDescription>
              {createStep === 'choose'
                ? 'Deploy a working first agent now. You can add more agents later.'
                : 'Choose an example or deploy another public GitHub repository.'}
            </DialogDescription>
          </DialogHeader>

          {createStep === 'choose' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                autoFocus
                className="hover:bg-muted/40 focus-visible:ring-ring/50 rounded-lg border p-5 text-left outline-none focus-visible:ring-3"
                onClick={() => {
                  setDialogOpen(false)
                  void navigate(
                    templateDeployPath(HELLO_WORLD_TEMPLATE_REPOSITORY, true),
                  )
                }}
              >
                <Rocket className="text-primary mb-4 size-5" />
                <p className="font-medium">From scratch</p>
                <p className="text-muted-foreground mt-1 text-sm leading-5">
                  Deploy a minimal Hello World and start its first Debug
                  session.
                </p>
                <span className="text-primary mt-4 inline-flex items-center gap-1 text-sm font-medium">
                  Quick start <ChevronRight className="size-4" />
                </span>
              </button>
              <button
                type="button"
                className="hover:bg-muted/40 focus-visible:ring-ring/50 rounded-lg border p-5 text-left outline-none focus-visible:ring-3"
                onClick={() => setCreateStep('templates')}
              >
                <FolderGit2 className="text-primary mb-4 size-5" />
                <p className="font-medium">Start from a template</p>
                <p className="text-muted-foreground mt-1 text-sm leading-5">
                  Begin with a complete example and configure its integrations.
                </p>
                <span className="text-primary mt-4 inline-flex items-center gap-1 text-sm font-medium">
                  Browse templates <ChevronRight className="size-4" />
                </span>
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid max-h-[45vh] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                {CURATED_TEMPLATES.map((template) => (
                  <button
                    key={template.repositoryUrl}
                    type="button"
                    className="hover:bg-muted/40 focus-visible:ring-ring/50 rounded-lg border p-4 text-left outline-none focus-visible:ring-3"
                    onClick={() => openTemplate(template.repositoryUrl)}
                  >
                    <p className="text-sm font-medium">{template.name}</p>
                    <p className="text-muted-foreground mt-1 text-xs leading-5">
                      {template.description}
                    </p>
                  </button>
                ))}
              </div>
              <form
                className="flex gap-2 border-t pt-4"
                onSubmit={submitRepository}
              >
                <Input
                  value={repositoryUrl}
                  onChange={(event) => setRepositoryUrl(event.target.value)}
                  placeholder="https://github.com/owner/repository"
                  aria-label="Template repository URL"
                />
                <Button type="submit" disabled={!repositoryUrl.trim()}>
                  Continue
                </Button>
              </form>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCreateStep('choose')}
              >
                <ChevronLeft /> Back
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
