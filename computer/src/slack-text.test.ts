import { describe, expect, it } from 'vitest';
import { addressed, decodeSlack } from './slack-text.js';

describe('decodeSlack', () => {
  it('unescapes entities so pasted code arrives as typed', () => {
    expect(decodeSlack('a &amp;&amp; b &lt;c&gt;')).toBe('a && b <c>');
  });

  it('keeps user and channel mentions readable', () => {
    expect(decodeSlack('<@U123> see <#C456|general>')).toBe('@U123 see #general');
    expect(decodeSlack('<@U123|owner>')).toBe('@owner');
  });

  it('turns special mentions into plain words', () => {
    expect(decodeSlack('<!here> and <!subteam^S1|@team>')).toBe('@here and @team');
  });

  it('shows auto-linked text as typed and labelled links with their URL', () => {
    expect(decodeSlack('<https://api.slack.com/apps|api.slack.com/apps>')).toBe('api.slack.com/apps');
    expect(decodeSlack('<https://example.com>')).toBe('https://example.com');
    expect(decodeSlack('<https://example.com|the docs>')).toBe('the docs (https://example.com)');
    expect(decodeSlack('<mailto:a@b.c|a@b.c>')).toBe('a@b.c');
  });

  it('leaves comparison operators and generics alone', () => {
    expect(decodeSlack('if (a &lt; b &amp;&amp; c &gt; d) Map&lt;string, number&gt;')).toBe('if (a < b && c > d) Map<string, number>');
  });
});

describe('addressed', () => {
  const B = 'UBOT';
  it('drops a leading mention: that is how people address the bot', () => {
    expect(addressed('<@UBOT> fix the build', B, 'Computer')).toEqual({ text: 'fix the build', mentioned: true, inline: false });
    expect(addressed('<@UBOT>: fix it', B, 'Computer').text).toBe('fix it');
  });

  it('keeps a mid-message mention where it was, as the bot', () => {
    expect(addressed('<@U1> can you ask <@UBOT> to check the logs?', B, 'Computer')).toEqual({
      text: '<@U1> can you ask @Computer (you) to check the logs?',
      mentioned: true,
      inline: true,
    });
  });

  it('a leading mention makes it addressed even with more mentions later', () => {
    expect(addressed('<@UBOT> what did <@UBOT> say?', B, 'Computer')).toEqual({
      text: 'what did @Computer (you) say?',
      mentioned: true,
      inline: false,
    });
  });

  it('no mention, or no bot id, leaves the text alone', () => {
    expect(addressed('just chatting', B, 'Computer')).toEqual({ text: 'just chatting', mentioned: false, inline: false });
    expect(addressed('<@UBOT> hi', undefined, 'Computer').mentioned).toBe(false);
  });
});
