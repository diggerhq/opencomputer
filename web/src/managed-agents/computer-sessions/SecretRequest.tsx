// Secret values go directly to the sealed session store, never through chat.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { putSessionSecret } from '../computer-secrets-api'
import { sendTurn, sessionKeys, type Ask } from '../computer-sessions-api'

export function SecretRequest({
  ask,
  onAnswered,
}: {
  ask: Ask
  onAnswered?: () => void
}) {
  const req = ask.secret
  const id = useId()
  const qc = useQueryClient()
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(false)
  const [fileError, setFileError] = useState(false)
  const fileRead = useRef(0)
  useEffect(
    () => () => {
      fileRead.current++
    },
    [],
  )
  const save = useMutation({
    mutationFn: async () => {
      if (!req) return
      if (!saved) {
        await putSessionSecret(ask.sessionId, req.name, value, req.file)
        setValue('')
        setSaved(true)
      }
      await sendTurn(
        ask.sessionId,
        `Secret $${req.name} is set for this session. It is available in your next command${req.file ? ' as the path of a file holding it' : ''}. Continue.`,
        'queue',
      )
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: sessionKeys.all })
      onAnswered?.()
    },
  })
  if (!req) return null
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!save.isPending && (saved || value)) save.mutate()
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <KeyRound className="text-muted-foreground size-4" aria-hidden />
        <label htmlFor={id} className="font-mono font-medium break-all">
          {req.name}
        </label>
      </div>
      <p className="text-muted-foreground text-sm">{req.purpose}</p>
      {req.file ? (
        <Input
          id={id}
          type="file"
          disabled={saved || save.isPending}
          onChange={(event) => {
            const read = ++fileRead.current
            const file = event.target.files?.[0]
            setValue('')
            setFileError(false)
            if (!file) return
            if (file.size > 64 * 1024) {
              setFileError(true)
              return
            }
            void file.text().then(
              (text) => {
                if (fileRead.current === read) setValue(text)
              },
              () => {
                if (fileRead.current === read) setFileError(true)
              },
            )
          }}
        />
      ) : (
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={value}
          disabled={saved || save.isPending}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      <p className="text-muted-foreground text-xs">
        Only this session can use this secret. Its value is never posted in the
        conversation.
      </p>
      {fileError ? (
        <p role="alert" className="text-destructive text-sm">
          Choose a readable text file up to 64 KB.
        </p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {saved
            ? 'Secret saved. Retry to resume the agent.'
            : 'Could not save the secret. Please retry.'}
        </p>
      ) : null}
      <Button
        type="submit"
        size="sm"
        disabled={save.isPending || (!saved && !value)}
      >
        {save.isPending
          ? 'Saving…'
          : saved
            ? 'Resume agent'
            : 'Save secret and continue'}
      </Button>
    </form>
  )
}
