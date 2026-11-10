/**
 * Voicemail transcription, done here rather than by Twilio.
 *
 * Twilio's own transcription is billed per minute and reads poorly on exactly
 * the phrasing that matters on these calls — a street address said quickly, a
 * name, a part number. It is also asynchronous, which would mean a third
 * callback to wait on.
 */

/** Twilio serves recordings from an authenticated URL. */
export async function fetchRecording(
  recordingUrl: string,
  credential: { accountSid: string; authToken: string },
): Promise<ArrayBuffer> {
  // Twilio appends the format; asking for wav avoids a transcode.
  const url = recordingUrl.endsWith(".wav")
    ? recordingUrl
    : `${recordingUrl}.wav`;
  const response = await fetch(url, {
    headers: {
      authorization: `Basic ${btoa(
        `${credential.accountSid}:${credential.authToken}`,
      )}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Twilio recording download failed (${String(response.status)})`);
  }
  return response.arrayBuffer();
}

interface WhisperResult {
  text?: string;
}

/**
 * Returns null rather than throwing when transcription fails or produces
 * nothing usable. A voicemail we could not read is a worse first text, not a
 * lost lead — the caller's number is reason enough to reach out.
 */
export async function transcribeRecording(
  ai: { run(model: string, input: unknown): Promise<unknown> },
  audio: ArrayBuffer,
): Promise<string | null> {
  try {
    const result = (await ai.run("@cf/openai/whisper", {
      audio: [...new Uint8Array(audio)],
    })) as WhisperResult;
    const text = typeof result?.text === "string" ? result.text.trim() : "";
    // Whisper emits filler for silence; a couple of words is not a message.
    return text.length >= 8 ? text : null;
  } catch {
    return null;
  }
}
