// A Slack file as the event carries it.

/** A Slack file as the event carries it; the runner downloads it with the bot token. */
export interface CalvinSlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}
