import { describe, expect, it } from 'vitest';
import { installerPerson } from './first-person.js';

describe('installerPerson', () => {
  it('takes the real name and makes the installer an admin', () => {
    expect(installerPerson('U0ABC', { name: 'sam', profile: { real_name: 'Sam Lee', display_name: 'sam' } })).toEqual({
      slackUserId: 'U0ABC',
      dir: 'u0abc',
      name: 'Sam Lee',
      gitName: 'Sam Lee',
      gitEmail: 'u0abc@users.noreply.slack.local',
      admin: true,
    });
  });

  it('falls back to the user id when the profile could not be read', () => {
    const p = installerPerson('U0ABC');
    expect(p.gitName).toBe('U0ABC');
    expect(p.admin).toBe(true);
  });

  it('uses the profile email when Slack gives one', () => {
    expect(installerPerson('U1', { profile: { email: 'sam@example.com' } }).gitEmail).toBe('sam@example.com');
  });
});
