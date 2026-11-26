import { useState } from 'react'
import type { SettingsPatch } from '@opencomputer/sdk/computer'
import { useSurface } from '../hooks'
import { Composer } from './Composer'
import { SettingsPickers } from './SettingsPickers'

// S5: one composer, no choice of kind. Nothing exists until the first message is sent.
export function StartBox() {
  const surface = useSurface()
  const [settings, setSettings] = useState<SettingsPatch>({})
  return (
    <div className="bg-background animate-in fade-in-0 slide-in-from-bottom-1 absolute inset-0 z-[2] flex flex-col items-center justify-center px-10 pb-[12vh] duration-200 max-[700px]:px-4">
      <h2 className="mb-4 text-xl font-semibold tracking-tight">
        What do you want done?
      </h2>
      <Composer
        draftKey="new"
        placeholder="A question, a fix, or something bigger"
        rows={2}
        className="w-full max-w-150 [&_textarea]:min-h-13"
        // The start box is its composer: New lands in it.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onSend={(text) => surface.start(text, { open: true, settings })}
        tools={
          <SettingsPickers
            value={settings}
            onChange={(p) => setSettings({ ...settings, ...p })}
          />
        }
      />
      <p className="text-muted-foreground mt-4 text-[12.5px]">
        No need to say what kind of thing it is.
        {surface.host.platform === 'desktop' && ' From any other app: ⌥Space.'}
      </p>
    </div>
  )
}
