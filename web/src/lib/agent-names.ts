// Memorable adjective-noun names so creating an agent never blocks on naming.
// Shared by the create dialog (Agents.tsx) and the deferred-action executor.
const NAME_ADJECTIVES = [
  'swift', 'calm', 'bright', 'clever', 'bold', 'quiet', 'keen', 'brave',
  'nimble', 'sunny', 'lucid', 'witty', 'deft', 'mellow', 'crisp', 'vivid',
]
const NAME_NOUNS = [
  'otter', 'harbor', 'falcon', 'cedar', 'comet', 'delta', 'ember', 'fjord',
  'grove', 'heron', 'lynx', 'maple', 'nova', 'quartz', 'sparrow', 'willow',
]

export function randomAgentName(): string {
  const pick = (a: readonly string[]) => a[Math.floor(Math.random() * a.length)]
  return `${pick(NAME_ADJECTIVES)}-${pick(NAME_NOUNS)}`
}
