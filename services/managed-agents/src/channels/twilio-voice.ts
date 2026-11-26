/**
 * The voice leg. Unlike every other webhook in this service, Twilio's voice
 * request is synchronous: the caller is on the line, and Twilio expects TwiML
 * back saying what to do with them. Answering with an acknowledgement hangs up
 * on a customer, which is worse than the voicemail they had before the number
 * was forwarded here.
 *
 * So the call is answered, a greeting is played, and a message is recorded.
 * Forwarding a business line here replaces the carrier's voicemail, and this is
 * what replaces it.
 */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface VoicemailPromptInput {
  /** Where Twilio posts the finished recording. */
  recordingCallbackUrl: string;
  /** Spoken before the beep. Kept short: callers hang up on long greetings. */
  greeting: string;
  /** Seconds of recording accepted. Twilio's own ceiling is 3600. */
  maxLengthSeconds?: number;
}

export function voicemailPrompt(input: VoicemailPromptInput): string {
  const seconds = Math.min(
    Math.max(input.maxLengthSeconds ?? 120, 10),
    3600,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say>${escapeXml(input.greeting)}</Say>`,
    `  <Record action="${escapeXml(input.recordingCallbackUrl)}"` +
      ` maxLength="${String(seconds)}" playBeep="true" trim="trim-silence"/>`,
    // Reached only if the caller hangs up without recording, which is a normal
    // ending rather than an error: the agent still has their number.
    "  <Hangup/>",
    "</Response>",
  ].join("\n");
}

export const DEFAULT_VOICEMAIL_GREETING =
  "Thanks for calling. We're with someone right now — " +
  "leave a message after the tone and we'll text you straight back.";

/** What a finished recording tells us, normalized. */
export interface TwilioRecording {
  callSid: string;
  from: string;
  to: string;
  /** Absent when the caller hung up before speaking. */
  recordingUrl?: string;
  durationSeconds?: number;
}

export function parseRecording(payload: string): TwilioRecording | null {
  const parameters = new URLSearchParams(payload);
  const callSid = parameters.get("CallSid");
  const from = parameters.get("From");
  const to = parameters.get("To");
  if (!callSid || !from || !to) return null;
  const url = parameters.get("RecordingUrl");
  const duration = Number(parameters.get("RecordingDuration"));
  return {
    callSid,
    from,
    to,
    // A one-second recording is a hangup, not a message.
    ...(url && Number.isFinite(duration) && duration >= 2
      ? { recordingUrl: url, durationSeconds: duration }
      : {}),
  };
}
