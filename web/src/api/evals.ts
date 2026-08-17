// Native agent evals — edge-owned (D1 in api-edge), not a /v3 sessions-api resource.
// The runner drives the session API to run the agent, so this is runtime-agnostic:
// flue, langgraph, claude, codex and pi are all just "the agent under test".
import { apiFetch } from './client'

export interface EvalExpect {
  contains?: string[]
  equals?: string
  iregex?: string
  outcome?: string
  tools?: string[]
  max_cost_usd?: number
}
export interface EvalExample {
  id: string
  input: string
  expect?: EvalExpect
}
export interface EvalDataset {
  id: string
  agent_id: string
  name: string
  examples: EvalExample[]
  created_at: number
  updated_at: number
}
export type EvalRunStatus = 'pending' | 'running' | 'done' | 'failed'
export interface EvalRun {
  id: string
  dataset_id: string
  agent_id: string
  status: EvalRunStatus
  total: number
  completed: number
  passed: number
  score: number | null
  error: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
}
export interface EvalScore {
  name: string
  pass: boolean
  detail?: string
}
export interface EvalResult {
  id: string
  run_id: string
  example_id: string
  input: string
  expect: EvalExpect
  state: 'pending' | 'running' | 'done' | 'failed'
  session_id: string | null
  output: string | null
  outcome: string | null
  cost_usd: number | null
  tokens: number | null
  scores: EvalScore[]
  passed: number | null
  error: string | null
}

export const getEvalDatasets = (agentId: string) =>
  apiFetch<{ data: EvalDataset[] }>(
    `/evals?agent_id=${encodeURIComponent(agentId)}`,
  ).then((r) => r.data)

export const createEvalDataset = (body: {
  agent_id: string
  name: string
  examples: EvalExample[]
}) =>
  apiFetch<EvalDataset>('/evals', {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const updateEvalDataset = (
  id: string,
  body: { name?: string; examples?: EvalExample[] },
) =>
  apiFetch<EvalDataset>(`/evals/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })

export const deleteEvalDataset = (id: string) =>
  apiFetch<void>(`/evals/${id}`, { method: 'DELETE' })

export const getEvalRuns = (datasetId: string) =>
  apiFetch<{ data: EvalRun[] }>(`/evals/${datasetId}/runs`).then((r) => r.data)

export const createEvalRun = (datasetId: string) =>
  apiFetch<EvalRun>(`/evals/${datasetId}/runs`, {
    method: 'POST',
    body: JSON.stringify({}),
  })

export const getEvalResults = (runId: string) =>
  apiFetch<{ data: EvalResult[] }>(`/evals/runs/${runId}/results`).then(
    (r) => r.data,
  )
