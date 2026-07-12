import { ExternalLink } from 'lucide-react'

export type ApiRef = {
  method?: string
  path?: string
  sdk?: string
  docs?: string
}

// A subtle "this page is an API" hint — the REST endpoint, the SDK call, and a
// docs link. Every screen here is a thin control panel over the public API/SDK;
// this nudges users toward driving it programmatically. Understated by design
// (muted, mono, small) so it reads as metadata, not chrome.
export function ApiHint({ method, path, sdk, docs }: ApiRef) {
  if (!path && !sdk && !docs) return null
  return (
    <div className="text-muted-foreground/70 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 overflow-hidden pt-1 text-xs">
      {path ? (
        <span className="max-w-full truncate font-mono">
          {method ? (
            <span className="text-muted-foreground/50">{method} </span>
          ) : null}
          {path}
        </span>
      ) : null}
      {sdk ? (
        <span className="text-muted-foreground/50 max-w-full truncate font-mono">
          {path ? '· ' : ''}
          {sdk}
        </span>
      ) : null}
      {docs ? (
        <a
          href={docs}
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground inline-flex items-center gap-1 underline-offset-4 hover:underline"
        >
          Docs
          <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  )
}
