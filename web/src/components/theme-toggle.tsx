import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/hooks/useTheme'

export function ThemeToggle() {
  const { dark, setDark } = useTheme()
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme'
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setDark(!dark)}
      aria-label={label}
      title={label}
      className="text-muted-foreground hover:text-foreground"
    >
      {dark ? (
        <Sun className="size-4" strokeWidth={1.5} aria-hidden />
      ) : (
        <Moon className="size-4" strokeWidth={1.5} aria-hidden />
      )}
    </Button>
  )
}
