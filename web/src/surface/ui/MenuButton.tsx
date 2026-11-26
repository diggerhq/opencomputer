import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { I } from './icons'
import { oneLayer } from './one-layer'
import { Tip } from './Tip'

// ---- a menu at a button (S6, S7) ----

export type MenuItem =
  | { label: string; onSelect?(): void; danger?: boolean; items?: MenuItem[] }
  | 'sep'

export function MenuButton({
  items,
  label = 'More',
}: {
  items: () => MenuItem[]
  label?: string
}) {
  const render = (list: MenuItem[]) =>
    list.map((it, i) =>
      it === 'sep' ? (
        <DropdownMenuSeparator key={i} />
      ) : it.items ? (
        <DropdownMenuSub key={i}>
          <DropdownMenuSubTrigger>{it.label}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent onEscapeKeyDown={oneLayer}>
            {render(it.items)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : (
        <DropdownMenuItem
          key={i}
          variant={it.danger ? 'destructive' : 'default'}
          onSelect={() => it.onSelect?.()}
        >
          {it.label}
        </DropdownMenuItem>
      ),
    )
  return (
    <DropdownMenu modal={false}>
      <Tip label={label}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="text-muted-foreground"
          >
            {I.dots}
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="end"
        className="min-w-52"
        onEscapeKeyDown={oneLayer}
      >
        {render(items())}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
