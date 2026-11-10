/**
 * Connecting Twilio, which has no install flow to redirect through.
 *
 * Slack hands back a token and registers the event subscription in one OAuth
 * round trip. Twilio's equivalent is an account SID and an auth token typed in
 * by the operator — so the work Slack's install does for free has to be done
 * explicitly here: prove the credentials, find out which numbers the account
 * owns, and point the chosen one at this service.
 *
 * Doing that last step for them is the difference between a setup an agency
 * can complete and one a plumber can. The alternative is a six-step walkthrough
 * of Twilio's console with two URLs to paste correctly.
 */

export interface TwilioCredential {
  accountSid: string;
  authToken: string;
}

export interface TwilioNumber {
  sid: string;
  phoneNumber: string;
  friendlyName: string;
  /** A number with no voice capability cannot take a missed call. */
  capabilities: { sms: boolean; voice: boolean };
}

function authHeader(credential: TwilioCredential): string {
  return `Basic ${btoa(`${credential.accountSid}:${credential.authToken}`)}`;
}

function accountUrl(credential: TwilioCredential, suffix: string): string {
  return (
    "https://api.twilio.com/2010-04-01/Accounts/" +
    encodeURIComponent(credential.accountSid) +
    suffix
  );
}

export class TwilioSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Prove the credentials before storing them, and name the account back. */
export async function verifyCredential(
  credential: TwilioCredential,
): Promise<{ friendlyName: string }> {
  const response = await fetch(accountUrl(credential, ".json"), {
    headers: { authorization: authHeader(credential) },
  });
  if (response.status === 401) {
    throw new TwilioSetupError(
      "twilio_credentials_rejected",
      "Twilio did not accept that account SID and auth token",
    );
  }
  if (!response.ok) {
    throw new TwilioSetupError(
      "twilio_unavailable",
      `Twilio returned ${String(response.status)}`,
    );
  }
  const account = (await response.json()) as {
    friendly_name?: string;
    status?: string;
  };
  if (account.status && account.status !== "active") {
    throw new TwilioSetupError(
      "twilio_account_inactive",
      `That Twilio account is ${account.status}`,
    );
  }
  return { friendlyName: account.friendly_name ?? credential.accountSid };
}

export async function listNumbers(
  credential: TwilioCredential,
): Promise<TwilioNumber[]> {
  const response = await fetch(
    accountUrl(credential, "/IncomingPhoneNumbers.json?PageSize=100"),
    { headers: { authorization: authHeader(credential) } },
  );
  if (!response.ok) {
    throw new TwilioSetupError(
      "twilio_unavailable",
      `Twilio returned ${String(response.status)}`,
    );
  }
  const page = (await response.json()) as {
    incoming_phone_numbers?: Array<{
      sid: string;
      phone_number: string;
      friendly_name?: string;
      capabilities?: { sms?: boolean; voice?: boolean };
    }>;
  };
  return (page.incoming_phone_numbers ?? []).map((number) => ({
    sid: number.sid,
    phoneNumber: number.phone_number,
    friendlyName: number.friendly_name ?? number.phone_number,
    capabilities: {
      sms: number.capabilities?.sms !== false,
      voice: number.capabilities?.voice !== false,
    },
  }));
}

/**
 * Point a number at this service. Both URLs, because a missed call and a text
 * arrive on different Twilio settings and a customer who only wires one gets a
 * system that half works in a way that is hard to diagnose.
 */
export async function configureNumber(
  credential: TwilioCredential,
  numberSid: string,
  urls: { smsUrl: string; voiceUrl: string },
): Promise<void> {
  const response = await fetch(
    accountUrl(
      credential,
      `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`,
    ),
    {
      method: "POST",
      headers: {
        authorization: authHeader(credential),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        SmsUrl: urls.smsUrl,
        SmsMethod: "POST",
        VoiceUrl: urls.voiceUrl,
        VoiceMethod: "POST",
      }).toString(),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new TwilioSetupError(
      "twilio_number_configuration_failed",
      `Twilio would not accept the webhook configuration: ${detail.slice(0, 200)}`,
    );
  }
}
