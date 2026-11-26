// A person as the host knows them: their directory and git identity on the computer.

export interface CalvinPerson {
  /**
   * The member's Slack id. Work 084: an `opc`-only person has none (`""`).
   */
  slackUserId: string;
  /** Work 084: the member, `usr_…` (the API's Person.id, the wire's member). */
  userId?: string;
  name?: string;
  email?: string;
  /** /data/people/<dir>: `slack-<id>` for a Slack person, `user-<id>` for one without (work 084). */
  dir: string;
  gitName: string;
  gitEmail: string;
}

/** The app's name in git, the author until a person's name is known. */
export const COMPUTER_GIT_NAME = "Computer";

/**
 * Every Slack user maps to one directory and git identity on the computer.
 * Commits name the person who asked, via Computer, with their Slack email
 * (GitHub links it to their profile when they verified it there); just
 * Computer and a no-reply address until Slack has told us.
 */
export function personFor(slackUserId: string, slack: { name?: string; email?: string; userId?: string } = {}): CalvinPerson {
  return {
    slackUserId,
    ...(slack.userId ? { userId: slack.userId } : {}),
    dir: `slack-${slackUserId.toLowerCase()}`,
    gitName: slack.name ? `${slack.name} via Computer` : COMPUTER_GIT_NAME,
    gitEmail: slack.email || noReplyGitEmail(slackUserId),
  };
}

/**
 * Work 084: a member with no Slack identity (an `opc` user). Their directory is
 * `user-<id>`, so it can never collide with a `slack-<id>` one.
 */
export function personForMember(userId: string, member: { name?: string; email?: string } = {}): CalvinPerson {
  const slug = userId.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return {
    slackUserId: "",
    userId,
    ...(member.name ? { name: member.name } : {}),
    ...(member.email ? { email: member.email } : {}),
    dir: `user-${slug}`,
    gitName: member.name ? `${member.name} via Computer` : COMPUTER_GIT_NAME,
    gitEmail: member.email || `${slug}@users.noreply.opencomputer.dev`,
  };
}

export function noReplyGitEmail(slackUserId: string): string {
  return `${slackUserId.toLowerCase()}@users.noreply.opencomputer.dev`;
}
