// Slack's own syntax in a message, made readable on the web. The agent writes
// for Slack, so its replies carry `<!date^…>` dates, `<url|label>` links and
// `<@U…>` mentions that Slack renders and Markdown shows raw.

type Options = { now?: Date; timeZone?: string; locale?: string }

const DAY = 86_400_000

function dayDiff(at: Date, now: Date, timeZone?: string): number {
  // Calendar days in the reader's zone, not 24-hour spans.
  const ymd = (d: Date) =>
    Date.parse(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d),
    )
  return Math.round((ymd(at) - ymd(now)) / DAY)
}

function agoText(at: Date, now: Date, locale?: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const s = Math.round((at.getTime() - now.getTime()) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86_400],
    ['month', 30 * 86_400],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ]
  for (const [unit, secs] of units)
    if (Math.abs(s) >= secs) return rtf.format(Math.round(s / secs), unit)
  return rtf.format(s, 'second')
}

/** One `<!date^…>` token's format, filled in as Slack would (https://api.slack.com/reference/surfaces/formatting#date-formatting). */
export function formatSlackDate(
  unix: number,
  format: string,
  { now = new Date(), timeZone, locale }: Options = {},
): string {
  const at = new Date(unix * 1000)
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone, ...o }).format(at)
  const date = () => fmt({ dateStyle: 'long' })
  const short = () => fmt({ dateStyle: 'medium' })
  const long = () => fmt({ dateStyle: 'full' })
  const pretty = (fallback: () => string) => {
    const diff = dayDiff(at, now, timeZone)
    if (Math.abs(diff) > 1) return fallback()
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      diff,
      'day',
    )
  }
  const tokens: Record<string, () => string> = {
    date_num: () =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(at),
    date,
    date_short: short,
    date_long: long,
    date_pretty: () => pretty(date),
    date_short_pretty: () => pretty(short),
    date_long_pretty: () => pretty(long),
    time: () => fmt({ timeStyle: 'short' }),
    time_secs: () => fmt({ timeStyle: 'medium' }),
    ago: () => agoText(at, now, locale),
  }
  return format.replace(/\{(\w+)\}/g, (whole, name: string) =>
    tokens[name] ? tokens[name]() : whole,
  )
}

/** A message's Slack syntax as plain Markdown. */
export function fromSlack(text: string, options: Options = {}): string {
  return (
    text
      // <!date^1700000000^{date_short} at {time}^https://link|fallback>
      .replace(
        /<!date\^(\d+)\^([^^|>]*)(?:\^([^|>]*))?(?:\|([^>]*))?>/g,
        (
          whole,
          unix: string,
          format: string,
          link?: string,
          fallback?: string,
        ) => {
          const n = Number(unix)
          if (!Number.isFinite(n)) return fallback ?? whole
          let shown: string
          try {
            shown = formatSlackDate(n, format, options)
          } catch {
            shown = fallback ?? whole
          }
          return link ? `[${shown}](${link})` : shown
        },
      )
      // <!here>, <!channel>, <!everyone>, <!subteam^S123|@team>
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
      .replace(
        /<!subteam\^\w+(?:\|([^>]*))?>/g,
        (_, label?: string) => label ?? '@group',
      )
      // The computer writes people as `@Sam (<@U123>)`: the name is enough.
      .replace(/(@[^\s(<][^(<\n]*?) \(<@[UW][A-Z0-9]+(?:\|[^>]*)?>\)/g, '$1')
      .replace(/<@[UW][A-Z0-9]+\|([^>]+)>/g, '@$1')
      .replace(/<@[UW][A-Z0-9]+>/g, '@someone')
      .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
      .replace(/<#C[A-Z0-9]+>/g, '#channel')
      // <https://x|label> and <mailto:a@b|label>
      .replace(
        /<((?:https?|mailto):[^|>\s]+)\|([^>]+)>/g,
        (_, url: string, label: string) => `[${label}](${url})`,
      )
  )
}
