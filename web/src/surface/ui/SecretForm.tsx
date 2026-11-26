import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { Ask } from '@opencomputer/sdk/computer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSurface } from '../hooks'
import { ACTS } from './kit'

// A secret the agent asked for: typed or uploaded, put straight in the
// session's sealed store, then the agent is told to continue. The value lives
// only in this form's state until it is sent; it is never logged or kept.

const MAX_FILE = 64 * 1024

export function SecretForm({ ask }: { ask: Ask }) {
  const surface = useSurface()
  const id = useId()
  const req = ask.secret ?? {}
  const name = typeof req.name === 'string' ? req.name : null
  const purpose = typeof req.purpose === 'string' ? req.purpose : null
  const file = req.file === true
  const [value, setValue] = useState('')
  const [fileError, setFileError] = useState(false)
  // A file read that finishes after another was chosen, or after unmount, is dropped.
  const fileRead = useRef(0)
  useEffect(
    () => () => {
      fileRead.current++
    },
    [],
  )
  const save = useMutation({
    mutationFn: () => surface.setSecret(ask.sessionId, name!, { value, file }),
    onSuccess: () => setValue(''),
  })
  const open = ask.status === 'open' && !save.isSuccess
  const label = name ? (
    <>
      This needs a secret:{' '}
      <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
        {name}
      </code>
    </>
  ) : (
    'This needs a secret.'
  )
  if (!open || !name)
    return (
      <>
        <div>{label}</div>
        {ask.status === 'open' &&
          (save.isSuccess ? (
            <div className="text-muted-foreground mt-2 text-[12.5px]">
              Saved
            </div>
          ) : (
            <div className={ACTS}>
              <Dismiss ask={ask} />
            </div>
          ))}
      </>
    )
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value && !save.isPending) save.mutate()
  }
  return (
    <form onSubmit={submit}>
      <label htmlFor={id}>{label}</label>
      {purpose && (
        <p className="text-muted-foreground mt-1 text-[12.5px]">{purpose}</p>
      )}
      {file ? (
        <Input
          id={id}
          type="file"
          className="bg-card mt-2"
          disabled={save.isPending}
          onChange={(e) => {
            const read = ++fileRead.current
            const f = e.target.files?.[0]
            setValue('')
            setFileError(false)
            if (!f) return
            if (f.size > MAX_FILE) return setFileError(true)
            void f.text().then(
              (text) => fileRead.current === read && setValue(text),
              () => fileRead.current === read && setFileError(true),
            )
          }}
        />
      ) : (
        <Input
          id={id}
          type="password"
          autoComplete="off"
          className="bg-card mt-2 h-8"
          value={value}
          disabled={save.isPending}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      {fileError && (
        <p role="alert" className="text-destructive mt-1 text-[12.5px]">
          Choose a readable text file up to 64 KB.
        </p>
      )}
      {save.isError && (
        <p role="alert" className="text-destructive mt-1 text-[12.5px]">
          Could not save the secret. Please retry.
        </p>
      )}
      <div className={ACTS}>
        <Button type="submit" size="sm" disabled={!value || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save secret and continue'}
        </Button>
        <Dismiss ask={ask} />
      </div>
    </form>
  )
}

function Dismiss({ ask }: { ask: Ask }) {
  const surface = useSurface()
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => surface.dismissAsk(ask.sessionId, ask.id)}
    >
      Dismiss
    </Button>
  )
}
