// The first person of a self-hosted instance (work 101): while the people
// table is empty, the Slack user who installs the app is added as a person
// and an admin, so a fresh instance answers its installer without SP_PEOPLE.
// Invariant: only an empty table gains anyone this way; a later install adds
// nobody, and SP_PEOPLE stays the way to add the rest of a team.

import type { SlackPerson } from '../protocol.js';

/** What users.info returns about the installer, when it could be read. */
export interface SlackProfile {
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string; email?: string };
}

/** The installer as a person. Without users:read.email the git email is a placeholder. */
export function installerPerson(slackUserId: string, user?: SlackProfile): SlackPerson {
  const name = user?.profile?.real_name || user?.real_name || user?.profile?.display_name || user?.name || slackUserId;
  return {
    slackUserId,
    dir: slackUserId.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    gitName: name,
    gitEmail: user?.profile?.email || `${slackUserId.toLowerCase()}@users.noreply.slack.local`,
    admin: true,
  };
}
