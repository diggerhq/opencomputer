// The workspace definition (which repositories each person's workspace
// clones) and where it comes from. Two sources (work 052):
//
//   SP_DEFINITION                 a JSON file shipped with the release (definitions/computer.json);
//                                 rootFiles sources are relative to that file.
//   <SP_DATA>/state/definition.json  the gateway's, from `welcome.definition` (an organization's computer);
//                                 rootFiles sources are relative to the release's definitions/ directory.
//
// Invariants: the gateway's, once saved, wins over SP_DEFINITION in every
// process (host, runners) because both look at the same file under SP_DATA; it
// is only ever replaced by a newer valid one, written atomically, so a restart
// before the next welcome keeps it and a malformed one never lands. A gateway
// definition is checked more strictly than a file the release ships: plain
// HTTPS remotes without credentials, and root files that stay inside their
// directories.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOST_DATA, type WorkspaceDefinition, type WorkspaceRepo } from '../protocol.js';
import { log } from '../log.js';

export type RepoDef = WorkspaceRepo;

/** A definition ready to use: rootFiles sources resolved to absolute paths. */
export interface Definition {
  name: string;
  repos: RepoDef[];
  /** Target path in the workspace root → absolute source path. */
  rootFiles: Record<string, string>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RELEASE_DEFINITIONS = path.resolve(import.meta.dirname, '..', '..', 'definitions');

/** Where the gateway's definition is kept. */
export const gatewayDefinitionPath = () => path.join(HOST_DATA, 'state', 'definition.json');

/** The definition file in effect: the gateway's if one was saved, else SP_DEFINITION. */
export function definitionFile(): string | undefined {
  const saved = gatewayDefinitionPath();
  return existsSync(saved) ? saved : process.env.SP_DEFINITION || undefined;
}

/** True when a workspace definition is configured; otherwise the host uses legacy scratch dirs. */
export function workspacesEnabled() {
  return !!definitionFile();
}

/** A date or ISO time: sortable as text and safe to show. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** `owner/name` of a remote: https://github.com/acme/widgets(.git), git@github.com:o/n.git, file:///x/o/n.git. */
export function repoSlug(remote: string) {
  const m = remote.replace(/\/+$/, '').replace(/\.git$/, '').match(/([^/:]+)\/([^/:]+)$/);
  return m ? `${m[1]}/${m[2]}` : remote;
}

/** Cloned only when a session checks it out (`checkout_repo`), never in the background. */
export const isLazy = (r: RepoDef) => r.clone === 'lazy';

/** A relative path that stays inside its directory: no absolute paths, no `..`. */
function contained(p: string) {
  return !!p && !path.isAbsolute(p) && !path.normalize(p).split(/[\\/]/).includes('..');
}

/**
 * Check a definition's shape and return it with only the known fields. Throws
 * on the first problem. `gateway`: the stricter rules for one the gateway sent.
 */
export function validateDefinition(raw: unknown, gateway = false): WorkspaceDefinition {
  const fail = (why: string): never => {
    throw new Error(`bad workspace definition: ${why}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('not an object');
  const d = raw as Record<string, unknown>;
  if (d.name !== undefined && typeof d.name !== 'string') fail('name is not a string');
  if (d.about !== undefined && typeof d.about !== 'string') fail('about is not a string');
  if (!Array.isArray(d.repos)) fail('repos is not an array');
  const seen = new Set<string>();
  const repos = (d.repos as unknown[]).map((x): WorkspaceRepo => {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const what = `repo ${JSON.stringify(x)}`;
    if (typeof r.name !== 'string' || !NAME.test(r.name)) fail(`${what}: bad name`);
    const name = r.name as string;
    if (seen.has(name)) fail(`${what}: duplicate name`);
    seen.add(name);
    if (typeof r.remote !== 'string' || !r.remote) fail(`${what}: no remote`);
    const remote = r.remote as string;
    if (gateway && !/^https:\/\/[^/@\s]+\/\S+$/.test(remote)) fail(`${what}: remote must be plain HTTPS without credentials`);
    if (r.branch !== undefined && (typeof r.branch !== 'string' || !r.branch)) fail(`${what}: bad branch`);
    if (r.setup !== undefined && !(Array.isArray(r.setup) && r.setup.every((c) => typeof c === 'string'))) fail(`${what}: setup is not a list of commands`);
    if (r.unpublished !== undefined && typeof r.unpublished !== 'boolean') fail(`${what}: unpublished is not a boolean`);
    if (r.clone !== undefined && r.clone !== 'eager' && r.clone !== 'lazy') fail(`${what}: clone is not eager or lazy`);
    for (const k of ['description', 'language', 'pushedAt'] as const)
      if (r[k] !== undefined && typeof r[k] !== 'string') fail(`${what}: ${k} is not a string`);
    return {
      name,
      remote,
      ...(r.branch !== undefined && { branch: r.branch as string }),
      ...(r.setup !== undefined && { setup: r.setup as string[] }),
      ...(r.unpublished !== undefined && { unpublished: r.unpublished as boolean }),
      ...(r.clone !== undefined && { clone: r.clone as 'eager' | 'lazy' }),
      // Index text only, but it lands in AGENTS.md: one line, bounded.
      ...(typeof r.description === 'string' && r.description.trim() && { description: oneLine(r.description, 200) }),
      ...(typeof r.language === 'string' && r.language.trim() && { language: oneLine(r.language, 40) }),
      ...(typeof r.pushedAt === 'string' && ISO_TIME.test(r.pushedAt) && !Number.isNaN(Date.parse(r.pushedAt)) && { pushedAt: r.pushedAt }),
    };
  });
  let rootFiles: Record<string, string> | undefined;
  if (d.rootFiles !== undefined) {
    if (!d.rootFiles || typeof d.rootFiles !== 'object' || Array.isArray(d.rootFiles)) fail('rootFiles is not an object');
    rootFiles = {};
    for (const [target, source] of Object.entries(d.rootFiles as Record<string, unknown>)) {
      if (!contained(target)) fail(`root file ${target}: target must be a relative path inside the workspace`);
      if (typeof source !== 'string' || !source) fail(`root file ${target}: no source`);
      if (gateway && !contained(source as string)) fail(`root file ${target}: source must be a relative path inside definitions/`);
      rootFiles[target] = source as string;
    }
  }
  return {
    ...(d.name !== undefined && { name: d.name as string }),
    ...(d.about !== undefined && { about: d.about as string }),
    repos,
    ...(rootFiles && { rootFiles }),
  };
}

/** Resolve rootFiles sources against `base`; the name defaults to `fallbackName`. */
export function resolveDefinition(def: WorkspaceDefinition, base: string, fallbackName: string): Definition {
  const rootFiles = Object.fromEntries(Object.entries(def.rootFiles ?? {}).map(([k, v]) => [k, path.resolve(base, v)]));
  return { name: def.name ?? fallbackName, repos: def.repos, rootFiles };
}

/** Read the definition in effect. Re-read on every use, so edits apply at the next cycle. */
export function loadDefinition(file = definitionFile()): Definition {
  if (!file) throw new Error('no workspace definition (SP_DEFINITION is not set and the gateway sent none)');
  const gateway = path.resolve(file) === path.resolve(gatewayDefinitionPath());
  let def: WorkspaceDefinition;
  try {
    def = validateDefinition(JSON.parse(readFileSync(file, 'utf8')), gateway);
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : e}`);
  }
  const shipped = process.env.SP_DEFINITION;
  const base = gateway ? (shipped ? path.dirname(path.resolve(shipped)) : RELEASE_DEFINITIONS) : path.dirname(path.resolve(file));
  return resolveDefinition(def, base, gateway ? 'gateway' : path.basename(file, '.json'));
}

/**
 * Keep the gateway's definition. Throws if it is malformed (the saved one, if
 * any, stays). Returns whether it differs from the saved one; an unchanged one
 * is not rewritten.
 */
export function saveGatewayDefinition(raw: unknown, file = gatewayDefinitionPath()): boolean {
  const text = `${JSON.stringify(validateDefinition(raw, true), null, 2)}\n`;
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, file);
  return true;
}

/** saveGatewayDefinition for the host's `welcome`: a malformed definition is logged and the previous kept; true if it changed. */
export function applyGatewayDefinition(raw: unknown): boolean {
  try {
    const changed = saveGatewayDefinition(raw);
    if (changed) log.info(`workspace definition from the gateway: ${(raw as { repos: unknown[] }).repos.length} repositories`);
    return changed;
  } catch (e) {
    log.error(`ignoring the gateway's workspace definition, keeping ${definitionFile() ?? 'none'}:`, e instanceof Error ? e.message : e);
    return false;
  }
}
