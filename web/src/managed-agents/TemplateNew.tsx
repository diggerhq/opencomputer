import { FormEvent, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ExternalLink, FolderGit2, Loader2, Rocket } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { notifyError } from '@/lib/errors'
import {
  createManagedTemplateInstallation,
  finalizeManagedTemplateInstallation,
  getManagedTemplateInstallation,
  inspectManagedTemplate,
  putAgentRuntimeVariable,
  putManagedProjectSecret,
} from './api'
import { templateInspectionError } from './template-inspection-error'
import { templatePlaygroundPath } from './template-continuation'

const GITHUB_REPOSITORY =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+$/

async function waitForInstallation(id: string) {
  const deadline = Date.now() + 10 * 60_000
  let installation = await getManagedTemplateInstallation(id)
  while (
    installation.state !== 'ready' &&
    installation.state !== 'failed' &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    installation = await getManagedTemplateInstallation(id)
  }
  return installation
}

export default function TemplateNew() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const repositoryUrl = searchParams.get('repository-url')?.trim() ?? ''
  const validRepository = GITHUB_REPOSITORY.test(repositoryUrl)
  const commandKey = useRef(crypto.randomUUID())
  const [projectName, setProjectName] = useState('')
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [variables, setVariables] = useState<Record<string, string>>({})
  const inspection = useQuery({
    queryKey: ['managed-template-inspection', repositoryUrl],
    queryFn: () => inspectManagedTemplate(repositoryUrl),
    enabled: validRepository,
    retry: false,
  })

  useEffect(() => {
    if (!inspection.data || projectName) return
    setProjectName(
      inspection.data.template.defaultProjectName ??
        inspection.data.template.name,
    )
    setVariables(
      Object.fromEntries(
        inspection.data.requirements.runtimeVariables
          .filter((requirement) => requirement.example)
          .map((requirement) => [requirement.name, requirement.example!]),
      ),
    )
  }, [inspection.data, projectName])

  const install = useMutation({
    mutationFn: async () => {
      const reviewed = inspection.data
      if (!reviewed) throw new Error('Review the template first.')
      const installation = await createManagedTemplateInstallation({
        inspectionId: reviewed.id,
        projectName: projectName.trim(),
        idempotencyKey: commandKey.current,
      })
      const installationAgentId = (localAgentId?: string) =>
        !localAgentId || localAgentId === reviewed.agents[0]?.id
          ? installation.projectAgentId
          : `${installation.projectAgentId}--${localAgentId}`
      for (const requirement of reviewed.requirements.secrets) {
        const value = secrets[requirement.name]
        if (!value && !requirement.required) continue
        await putManagedProjectSecret({
          projectId: installation.projectId,
          environment: 'development',
          agentId: installationAgentId(requirement.agentId),
          name: requirement.name,
          value: value ?? '',
          allowedOrigins: requirement.allowedOrigins,
        })
        setSecrets((current) => ({ ...current, [requirement.name]: '' }))
      }
      for (const requirement of reviewed.requirements.runtimeVariables) {
        const value = variables[requirement.name]?.trim()
        if (!value) continue
        await putAgentRuntimeVariable({
          projectId: installation.projectId,
          environment: 'development',
          agentId: installationAgentId(requirement.agentId),
          name: requirement.name,
          value,
        })
      }
      const finalized = await finalizeManagedTemplateInstallation(
        installation.id,
      )
      return finalized.state === 'ready'
        ? finalized
        : waitForInstallation(finalized.id)
    },
    onSuccess: (result) => {
      if (result.state === 'failed') {
        notifyError(
          "Couldn't deploy the template.",
          new Error(result.error?.message ?? 'Template installation failed.'),
        )
        return
      }
      if (result.state !== 'ready') {
        notifyError(
          'Template deployment is still running.',
          new Error('Open the draft project to continue.'),
        )
        void navigate(result.projectUrl)
        return
      }
      void navigate(templatePlaygroundPath(result))
    },
    onError: (error) => notifyError("Couldn't deploy the template.", error),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    install.mutate()
  }

  if (!validRepository) {
    return (
      <Panel>
        <EmptyState
          icon={FolderGit2}
          title="Invalid template repository"
          description="Use a root GitHub repository URL without a branch, path, query, or .git suffix. V1 resolves the repository's main branch server-side."
        />
      </Panel>
    )
  }

  if (inspection.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  if (inspection.isError || !inspection.data) {
    const error = templateInspectionError(inspection.error)
    return (
      <Panel>
        <EmptyState
          icon={FolderGit2}
          title={error.title}
          description={error.description}
          action={
            <Button variant="outline" onClick={() => void inspection.refetch()}>
              Try again
            </Button>
          }
        />
      </Panel>
    )
  }

  const reviewed = inspection.data
  const missingRequiredVariable = reviewed.requirements.runtimeVariables.some(
    (requirement) =>
      requirement.required && !variables[requirement.name]?.trim(),
  )
  const missingSecret = reviewed.requirements.secrets.some(
    (requirement) => requirement.required && !secrets[requirement.name],
  )

  return (
    <form className="space-y-6" onSubmit={submit}>
      <PageHeader
        title={reviewed.template.name}
        description={reviewed.template.description}
      />
      <Panel>
        <PanelHeader>
          <PanelTitle>Source and deployment</PanelTitle>
        </PanelHeader>
        <PanelContent className="space-y-3 text-sm">
          <a
            className="inline-flex items-center gap-2 underline underline-offset-4"
            href={reviewed.repository.url}
            target="_blank"
            rel="noreferrer"
          >
            {reviewed.repository.fullName}
            <ExternalLink className="size-3.5" />
          </a>
          <p className="text-muted-foreground font-mono text-xs">
            main @ {reviewed.repository.commitSha.slice(0, 12)}
          </p>
          <p>
            {reviewed.agents.length} agent
            {reviewed.agents.length === 1 ? '' : 's'} · Development only
          </p>
        </PanelContent>
      </Panel>
      <Panel>
        <PanelHeader>
          <PanelTitle>Configure project</PanelTitle>
        </PanelHeader>
        <PanelContent className="space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span>Project name</span>
            <Input
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              required
            />
          </label>
          {reviewed.requirements.secrets.map((requirement) => (
            <label key={requirement.name} className="block space-y-1.5 text-sm">
              <span>
                {requirement.name}
                {requirement.required ? '' : ' (optional)'}
              </span>
              {requirement.description ? (
                <span className="text-muted-foreground block text-xs">
                  {requirement.description} Stored write-only for Development.
                </span>
              ) : null}
              <Input
                type="password"
                autoComplete="off"
                value={secrets[requirement.name] ?? ''}
                onChange={(event) =>
                  setSecrets((current) => ({
                    ...current,
                    [requirement.name]: event.target.value,
                  }))
                }
                required={requirement.required}
              />
            </label>
          ))}
          {reviewed.requirements.runtimeVariables.map((requirement) => (
            <label key={requirement.name} className="block space-y-1.5 text-sm">
              <span>{requirement.name}</span>
              {requirement.description ? (
                <span className="text-muted-foreground block text-xs">
                  {requirement.description} Visible to the agent runtime.
                </span>
              ) : null}
              <Input
                value={variables[requirement.name] ?? ''}
                placeholder={requirement.example}
                required={requirement.required}
                onChange={(event) =>
                  setVariables((current) => ({
                    ...current,
                    [requirement.name]: event.target.value,
                  }))
                }
              />
            </label>
          ))}
        </PanelContent>
      </Panel>
      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={
            !projectName.trim() ||
            missingSecret ||
            missingRequiredVariable ||
            install.isPending
          }
        >
          {install.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Rocket />
          )}
          {install.isPending ? 'Deploying…' : 'Deploy to Development'}
        </Button>
      </div>
    </form>
  )
}
