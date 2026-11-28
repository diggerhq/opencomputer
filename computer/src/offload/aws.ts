// Every AWS call the offload service makes (work 136): Lambda MicroVMs and S3,
// with the SDK's default credential chain (on the box: the instance role
// through IMDSv2; AWS_EC2_METADATA_V1_DISABLED is set by the unit).
//
// Invariants:
// - A MicroVM's life is bounded by AWS itself: maximumDurationInSeconds is the
//   job's minutes (at most SP_OFFLOAD_MAX_MINUTES) plus 2, and an idle policy
//   suspends and ends one nobody talks to, so a dead service leaks nothing
//   for long. clientToken is the job id: a retried run is the same MicroVM.
// - RunMicrovm takes no tags: TagResource follows it, best effort (a MicroVM
//   that could not be tagged is still the ledger's, by id).
// - Presigned URLs live 15 minutes; the builder's upload URLs are re-signed
//   while a job runs (jobs.ts). Auth tokens live 60 minutes, port 8080 only.
// - Terminate of a MicroVM that is already gone is success.

import {
  CreateMicrovmAuthTokenCommand, GetMicrovmCommand, LambdaMicrovmsClient, ListMicrovmsCommand, ListTagsCommand, type MicrovmItem, type MicrovmState,
  ResourceNotFoundException, RunMicrovmCommand, TagResourceCommand, TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const PRESIGN_SECONDS = 15 * 60;
export const TOKEN_MINUTES = 60;
export const AGENT_PORT = 8080;
export const IDLE_POLICY = { maxIdleDurationSeconds: 900, suspendedDurationSeconds: 300, autoResumeEnabled: true };

export interface RunSpec {
  jobId: string;
  image: string;
  imageVersion?: string;
  /** The job's own limit, in minutes; capped at `maxMinutes`. */
  minutes: number;
  maxMinutes: number;
}

/** `maximumDurationInSeconds` for a job: its minutes, at most the host's cap, plus 2 minutes of grace. */
export const maxDurationSeconds = (minutes: number, maxMinutes: number) => Math.min(minutes, maxMinutes) * 60 + 120;

export interface Aws {
  run(s: RunSpec): Promise<{ microvmId: string; endpoint: string }>;
  state(microvmId: string): Promise<MicrovmState | undefined>;
  tag(microvmId: string, tags: Record<string, string>): Promise<void>;
  tags(microvmId: string): Promise<Record<string, string>>;
  authToken(microvmId: string): Promise<string>;
  terminate(microvmId: string): Promise<void>;
  list(image: string): Promise<MicrovmItem[]>;
  presignPut(key: string): Promise<string>;
  presignGet(key: string): Promise<string>;
}

export interface AwsDeps {
  region: string;
  /** For MicroVM ARNs (TagResource, ListTags). */
  accountId: string;
  bucket: string;
  /** Tests pass clients built on mocks; otherwise the default chain. */
  microvms?: LambdaMicrovmsClient;
  s3?: S3Client;
}

export function aws(d: AwsDeps): Aws {
  const mv = d.microvms ?? new LambdaMicrovmsClient({ region: d.region });
  const s3 = d.s3 ?? new S3Client({ region: d.region });
  const arn = (id: string) => `arn:aws:lambda:${d.region}:${d.accountId}:microvm:${id}`;
  const gone = (e: unknown) => e instanceof ResourceNotFoundException || (e as { name?: string })?.name === 'ResourceNotFoundException';
  return {
    async run(s) {
      const r = await mv.send(new RunMicrovmCommand({
        imageIdentifier: s.image, imageVersion: s.imageVersion, clientToken: s.jobId,
        maximumDurationInSeconds: maxDurationSeconds(s.minutes, s.maxMinutes), idlePolicy: IDLE_POLICY,
      }));
      if (!r.microvmId || !r.endpoint) throw new Error('RunMicrovm answered without an id or endpoint');
      return { microvmId: r.microvmId, endpoint: r.endpoint };
    },
    async state(id) {
      try {
        return (await mv.send(new GetMicrovmCommand({ microvmIdentifier: id }))).state;
      } catch (e) {
        if (gone(e)) return 'TERMINATED';
        throw e;
      }
    },
    async tag(id, tags) {
      await mv.send(new TagResourceCommand({ Resource: arn(id), Tags: tags }));
    },
    async tags(id) {
      return (await mv.send(new ListTagsCommand({ Resource: arn(id) }))).Tags ?? {};
    },
    async authToken(id) {
      const r = await mv.send(new CreateMicrovmAuthTokenCommand({ microvmIdentifier: id, expirationInMinutes: TOKEN_MINUTES, allowedPorts: [{ port: AGENT_PORT }] }));
      const t = r.authToken?.['X-aws-proxy-auth'];
      if (!t) throw new Error('CreateMicrovmAuthToken answered without a token');
      return t;
    },
    async terminate(id) {
      try {
        await mv.send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
      } catch (e) {
        if (!gone(e)) throw e;
      }
    },
    async list(image) {
      const out: MicrovmItem[] = [];
      let nextToken: string | undefined;
      do {
        const r = await mv.send(new ListMicrovmsCommand({ imageIdentifier: image, nextToken }));
        out.push(...(r.items ?? []));
        nextToken = r.nextToken;
      } while (nextToken);
      return out;
    },
    presignPut: (key) => getSignedUrl(s3, new PutObjectCommand({ Bucket: d.bucket, Key: key }), { expiresIn: PRESIGN_SECONDS }),
    presignGet: (key) => getSignedUrl(s3, new GetObjectCommand({ Bucket: d.bucket, Key: key }), { expiresIn: PRESIGN_SECONDS }),
  };
}
