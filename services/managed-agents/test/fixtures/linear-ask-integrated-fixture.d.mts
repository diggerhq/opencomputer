export const LINEAR_ASK_MODEL: string;
export const artifactBundle: Uint8Array;
export function artifactDigest(): Promise<string>;
export function mockModel(request: Request): Promise<Response>;
