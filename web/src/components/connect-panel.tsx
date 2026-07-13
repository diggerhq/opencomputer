import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { notifyError } from '@/lib/errors'
import { cn } from '@/lib/utils'

type Lang = 'shell' | 'ts' | 'python'

const TABS: { key: Lang; label: string }[] = [
  { key: 'shell', label: 'Shell' },
  { key: 'ts', label: 'TypeScript' },
  { key: 'python', label: 'Python' },
]

// Real, copy-and-go snippets for reaching THIS sandbox by id. The SDK/CLI both
// read the key from OPENCOMPUTER_API_KEY (or `oc config`), so we never inline a
// secret — the placeholder + API-keys link is the auth story.
function snippetFor(lang: Lang, id: string): string {
  switch (lang) {
    case 'shell':
      return [
        '# one-time: point the CLI at your account',
        'oc config set api-key <your-key>',
        '',
        '# drop into an interactive shell on this sandbox',
        `oc shell ${id}`,
      ].join('\n')
    case 'ts':
      return [
        '// npm i @opencomputer/sdk   ·   export OPENCOMPUTER_API_KEY=<your-key>',
        'import { Sandbox } from "@opencomputer/sdk"',
        '',
        `const sandbox = await Sandbox.connect("${id}")`,
        'const { stdout } = await sandbox.exec.run("echo hello from code")',
        'console.log(stdout)',
      ].join('\n')
    case 'python':
      return [
        '# pip install opencomputer-sdk   ·   export OPENCOMPUTER_API_KEY=<your-key>',
        'import asyncio',
        'from opencomputer import Sandbox',
        '',
        'async def main():',
        `    sandbox = await Sandbox.connect("${id}")`,
        '    result = await sandbox.exec.run("echo hello from code")',
        '    print(result.stdout)',
        '',
        'asyncio.run(main())',
      ].join('\n')
  }
}

function CodeBlock({ code }: { code: string }) {
  const [copied, markCopied] = useTransientFlag(1500)
  const copy = () => {
    void navigator.clipboard.writeText(code).then(
      () => markCopied(),
      (e: unknown) => notifyError("Couldn't copy to clipboard.", e),
    )
  }
  return (
    <div className="bg-panel-2 relative overflow-hidden rounded-md border">
      <Button
        variant="ghost"
        size="xs"
        onClick={copy}
        className="text-muted-foreground hover:text-foreground absolute top-2 right-2 z-10"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <pre className="text-foreground overflow-x-auto px-3 py-3 pr-20 font-mono text-[12.5px] leading-relaxed">
        {code}
      </pre>
    </div>
  )
}

/**
 * "Connect" reference for a sandbox — shell in via the CLI or drive it from the
 * TypeScript / Python SDKs, prefilled with this sandbox's id.
 */
export function ConnectPanel({ sandboxId }: { sandboxId: string }) {
  const [lang, setLang] = useState<Lang>('shell')
  return (
    <Panel className="p-6">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold">Connect</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Shell in or drive this sandbox from your code.
          </p>
        </div>
        <div className="bg-secondary inline-flex w-fit rounded-md p-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setLang(t.key)}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium transition-colors',
                lang === t.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <CodeBlock code={snippetFor(lang, sandboxId)} />

      <p className="text-muted-foreground mt-3 text-xs">
        Need a key?{' '}
        <Link
          to="/api-keys"
          className="text-foreground font-medium underline underline-offset-4"
        >
          Create one on the API Keys page
        </Link>
        .
      </p>
    </Panel>
  )
}
