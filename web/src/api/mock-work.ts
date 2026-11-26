// Preview data for the Work routes: the knowledge repository setting and
// what the GitHub installations grant.
//
// `?work=` picks a scenario: no-github (GitHub not connected, so no
// repository), none (no repository set), problem (the repository cannot be
// read), missing (the routes answer 404, as before the service ships).

import { ApiError } from './errors'

const PREFIX = '/managed-agents/computer/work'
const MIN = 60_000
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString()
const H = 60
const D = 24 * H

type Json = Record<string, unknown>

const repo = {
  installationId: '1',
  owner: 'acme',
  name: 'knowledge',
  branch: 'main',
  problem: null as string | null,
  problemMessage: null as string | null,
}
let repository: typeof repo | null = repo

// What the preview's GitHub installations grant (the computer mock's acme and
// acme-labs), most recently pushed first as the server sends them.
const granted = (
  owner: string,
  list: [name: string, isPrivate: boolean, pushed: number | null][],
) =>
  list.map(([name, isPrivate, pushed], i) => ({
    id: (owner === 'acme' ? 1000 : 2000) + i,
    owner,
    name,
    private: isPrivate,
    defaultBranch: name === 'legacy-site' ? 'master' : 'main',
    pushedAt: pushed === null ? null : ago(pushed),
  }))
const granting = [
  {
    id: '1',
    accountLogin: 'acme',
    accountType: 'Organization',
    settingsUrl:
      'https://github.com/organizations/acme/settings/installations/41000001',
    repositories: granted('acme', [
      ['app', true, 12],
      ['knowledge', true, 3 * H],
      ['infra', true, 26 * H],
      ['docs', false, 3 * D],
      ['design-system', false, 9 * D],
      ['mobile', true, 21 * D],
      ['legacy-site', false, 140 * D],
      ['scratch', true, null],
    ]),
    truncated: false,
    problem: null,
    problemMessage: null,
  },
  {
    id: '2',
    accountLogin: 'acme-labs',
    accountType: 'Organization',
    settingsUrl:
      'https://github.com/organizations/acme-labs/settings/installations/41000002',
    repositories: granted('acme-labs', [
      ['experiments', true, 2 * D],
      ['notes', false, 30 * D],
    ]),
    truncated: false,
    problem: null,
    problemMessage: null,
  },
]

function scenario() {
  return typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('work')
}

// `?work=problem` reads `&problem=<code>` from the page's address (default
// access_denied); access_denied comes with the server's own sentence, the
// others with none, so the web's own words show.
function problemOf() {
  const code =
    (typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('problem')) ??
    'access_denied'
  return {
    problem: code,
    problemMessage:
      code === 'access_denied'
        ? "The installation cannot read the repository's contents."
        : null,
  }
}

// Returns undefined for paths it does not serve.
export function workMock(
  path: string,
  method: string,
  input: unknown,
): unknown {
  const [pathname] = path.split('?')
  if (!pathname.startsWith(PREFIX)) return undefined
  const rest = pathname.slice(PREFIX.length)
  const s = scenario()
  if (s === 'missing') throw new ApiError('Not found', 404)
  const current =
    s === 'none' || s === 'no-github'
      ? null
      : s === 'problem' && repository
        ? { ...repository, ...problemOf() }
        : repository

  if (rest === '/repository') {
    if (method === 'PUT') {
      const body = JSON.parse(typeof input === 'string' ? input : '{}') as Json
      repository = { ...repo, ...body, problem: null, problemMessage: null }
      return { repository }
    }
    return { repository: current }
  }
  if (rest === '/repositories' && method === 'GET') {
    return { installations: s === 'no-github' ? [] : granting }
  }
  return undefined
}
