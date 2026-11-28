import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateMicrovmAuthTokenCommand, GetMicrovmCommand, LambdaMicrovmsClient, ListMicrovmsCommand, ResourceNotFoundException, RunMicrovmCommand,
  TagResourceCommand, TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDLE_POLICY, aws, maxDurationSeconds } from './aws.js';

// Mocks only: no call reaches AWS. Fake static credentials let the presigner sign offline.
const credentials = { accessKeyId: 'AKIDTESTONLY', secretAccessKey: 'test-only' };
const microvms = new LambdaMicrovmsClient({ region: 'us-east-1', credentials });
const s3 = new S3Client({ region: 'us-east-1', credentials });
const mv = mockClient(microvms);
const a = aws({ region: 'us-east-1', accountId: '123456789012', bucket: 'bkt', microvms, s3 });
const item = (microvmId: string) => ({ microvmId, state: 'RUNNING' as const, imageArn: 'arn', imageVersion: '1', startedAt: new Date(0) });
const notFound = () => new ResourceNotFoundException({ message: 'gone', $metadata: {} });

beforeEach(() => mv.reset());

describe('aws', () => {
  it('maximum duration is min(job, cap) minutes plus 2', () => {
    expect(maxDurationSeconds(10, 60)).toBe(720);
    expect(maxDurationSeconds(600, 60)).toBe(3720);
  });
  it('RunMicrovm: job id as clientToken, idle policy, maximum duration', async () => {
    mv.on(RunMicrovmCommand).resolves({ microvmId: 'mv-1', endpoint: 'mv-1.example' });
    expect(await a.run({ jobId: 'j1', image: 'img', imageVersion: '3', minutes: 30, maxMinutes: 60 })).toEqual({ microvmId: 'mv-1', endpoint: 'mv-1.example' });
    expect(mv.commandCalls(RunMicrovmCommand)[0].args[0].input).toEqual({
      imageIdentifier: 'img', imageVersion: '3', clientToken: 'j1', maximumDurationInSeconds: 1920, idlePolicy: IDLE_POLICY,
    });
  });
  it('tags by MicroVM ARN', async () => {
    mv.on(TagResourceCommand).resolves({});
    await a.tag('mv-1', { 'opencomputer:job': 'j1' });
    expect(mv.commandCalls(TagResourceCommand)[0].args[0].input).toEqual({ Resource: 'arn:aws:lambda:us-east-1:123456789012:microvm:mv-1', Tags: { 'opencomputer:job': 'j1' } });
  });
  it('auth token: port 8080, 60 minutes', async () => {
    mv.on(CreateMicrovmAuthTokenCommand).resolves({ authToken: { 'X-aws-proxy-auth': 'tok' } });
    expect(await a.authToken('mv-1')).toBe('tok');
    expect(mv.commandCalls(CreateMicrovmAuthTokenCommand)[0].args[0].input).toEqual({ microvmIdentifier: 'mv-1', expirationInMinutes: 60, allowedPorts: [{ port: 8080 }] });
  });
  it('terminate and state treat not found as gone', async () => {
    mv.on(TerminateMicrovmCommand).rejects(notFound());
    await expect(a.terminate('mv-1')).resolves.toBeUndefined();
    mv.on(GetMicrovmCommand).rejects(notFound());
    expect(await a.state('mv-1')).toBe('TERMINATED');
    mv.on(TerminateMicrovmCommand).rejects(new Error('throttled'));
    await expect(a.terminate('mv-1')).rejects.toThrow('throttled');
  });
  it('lists every page', async () => {
    mv.on(ListMicrovmsCommand, { imageIdentifier: 'img', nextToken: undefined }).resolves({ items: [item('a')], nextToken: 'n' })
      .on(ListMicrovmsCommand, { imageIdentifier: 'img', nextToken: 'n' }).resolves({ items: [item('b')] });
    expect((await a.list('img')).map((i) => i.microvmId)).toEqual(['a', 'b']);
  });
  it('presigns PUT and GET for 15 minutes', async () => {
    const put = new URL(await a.presignPut('offload/h/j1/src.tgz'));
    expect(put.pathname).toContain('offload/h/j1/src.tgz');
    expect(put.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(put.searchParams.get('x-id')).toBe('PutObject');
    expect(new URL(await a.presignGet('k')).searchParams.get('x-id')).toBe('GetObject');
  });
});
