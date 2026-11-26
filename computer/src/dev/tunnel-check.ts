// Checks the tunnel + Bolt HTTP receiver path without Slack credentials:
// starts ngrok, serves Bolt on PORT, and sends a url_verification through the tunnel.
import { createHmac } from 'node:crypto';
import { App, LogLevel } from '@slack/bolt';
import { startTunnel } from '../provision.js';

const PORT = 3171;
const secret = 'test-signing-secret';
const url = await startTunnel(PORT);
console.log('tunnel', url);
const app = new App({ signingSecret: secret, token: 'xoxb-unused', tokenVerificationEnabled: false, logLevel: LogLevel.ERROR });
await app.start(PORT);
const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123', token: 'x' });
const ts = Math.floor(Date.now() / 1000);
const sig = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
const r = await fetch(`${url}/slack/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig },
  body,
});
console.log('url_verification via tunnel:', r.status, await r.text());
process.exit(0);
