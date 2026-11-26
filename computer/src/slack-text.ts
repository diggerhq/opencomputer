/**
 * Slack message text → what the user typed. Slack wraps links, mentions and
 * channels in <…> and escapes &, <, > as entities; the model should see plain
 * text, otherwise pasted code arrives as `&amp;&amp;`.
 */
export function decodeSlack(text: string): string {
  return text
    .replace(/<([^<>]+)>/g, (_, inner: string) => {
      const [target, label] = inner.split('|', 2) as [string, string | undefined];
      if (target.startsWith('@')) return label ? `@${label}` : target;
      if (target.startsWith('#')) return label ? `#${label}` : target;
      if (target.startsWith('!')) return label ?? `@${target.slice(1).split('^')[0]}`;
      const url = target.replace(/^mailto:/, '');
      // Auto-linked text (`api.slack.com/apps`) reads best as typed; a real label keeps its URL.
      if (!label || url.endsWith(label) || label.endsWith(url)) return label ?? url;
      return `${label} (${url})`;
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Where a message @mentions the bot, and its text for the model. A leading
 * mention is how people address the bot and is dropped (`@bot fix it` → `fix
 * it`); one mid-sentence stays, as `@<name> (you)`, so "ask @bot to check" keeps
 * its meaning. `inline` is true when the bot is mentioned only mid-message,
 * which may be a request or a remark about it.
 */
export function addressed(text: string, botUserId: string | undefined, name: string): { text: string; mentioned: boolean; inline: boolean } {
  if (!botUserId) return { text, mentioned: false, inline: false };
  const mention = `<@${botUserId}>`;
  // Slack user ids are [A-Z0-9]: safe inside a pattern.
  const lead = new RegExp(`^\\s*${mention}[\\s,:]*`);
  const leading = lead.test(text);
  const rest = text.replace(lead, '');
  const inline = rest.includes(mention);
  return { text: rest.replaceAll(mention, `@${name} (you)`), mentioned: leading || inline, inline: inline && !leading };
}
