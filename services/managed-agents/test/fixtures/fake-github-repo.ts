import { createHash } from "node:crypto";

/**
 * A knowledge repository on a fake GitHub, as much of the REST API as the Work index uses: the
 * branch ref (with ETag), compare (with rename detection), commits (one, and filtered by path),
 * trees (a commit's root, then one directory), blobs, the repository, and the pull request
 * GraphQL query. History is a list of commits with whole-tree snapshots; `forcePush` rewrites it.
 */

export interface FakeCommit {
  sha: string;
  parent: string | null;
  message: string;
  author: { name: string; email: string };
  at: string;
  files: Map<string, string>;
}

export interface FakePull {
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  title: string;
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

export class FakeRepo {
  owner = "acme";
  name = "knowledge";
  defaultBranch = "main";
  commits = new Map<string, FakeCommit>();
  head: string | null = null;
  /** Every request, as `METHOD path`. */
  log: string[] = [];
  /** The next requests answer this (then normal service resumes). */
  failNext: { status: number; headers?: Record<string, string> }[] = [];
  remaining = 5000;
  limit = 5000;
  deleted = false;
  pulls = new Map<string, FakePull>();
  private clock = Date.parse("2026-11-01T00:00:00Z");

  constructor(initial: Record<string, string> = {}) {
    this.commit(initial, "Initial", { name: "Ana", email: "ana@acme.test" });
  }

  /** A commit on the branch: `changes` maps a path to its new text, or null to remove it. */
  commit(changes: Record<string, string | null>, message = "Update", author = { name: "Ana", email: "ana@acme.test" }, renames: Record<string, string> = {}): string {
    const files = new Map(this.head ? this.commits.get(this.head)!.files : []);
    for (const [from, to] of Object.entries(renames)) {
      files.set(to, files.get(from)!);
      files.delete(from);
    }
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) files.delete(path);
      else files.set(path, text);
    }
    this.clock += 60_000;
    const sha = sha1(`${this.head}\n${message}\n${this.clock}\n${[...files].join("\n")}`);
    this.commits.set(sha, { sha, parent: this.head, message, author, at: new Date(this.clock).toISOString(), files });
    this.head = sha;
    return sha;
  }

  /** Rewrites history: a new root commit with these files; the old commits are forgotten. */
  forcePush(files: Record<string, string>, message = "Rewritten"): string {
    this.commits.clear();
    this.head = null;
    return this.commit(files, message);
  }

  blobSha(text: string): string {
    return sha1(`blob\n${text}`);
  }

  private ancestors(sha: string): string[] {
    const out: string[] = [];
    for (let c: string | null = sha; c; c = this.commits.get(c)?.parent ?? null) out.push(c);
    return out;
  }

  /** The files a commit changed against its parent, GitHub style (renames by equal content). */
  diff(from: Map<string, string>, to: Map<string, string>) {
    const out: { filename: string; status: string; previous_filename?: string; sha?: string }[] = [];
    const removed = [...from.keys()].filter((p) => !to.has(p));
    const added = [...to.keys()].filter((p) => !from.has(p));
    const renamedFrom = new Set<string>();
    for (const p of added) {
      const source = removed.find((r) => !renamedFrom.has(r) && from.get(r) === to.get(p));
      if (source) {
        renamedFrom.add(source);
        out.push({ filename: p, status: "renamed", previous_filename: source, sha: this.blobSha(to.get(p)!) });
      } else out.push({ filename: p, status: "added", sha: this.blobSha(to.get(p)!) });
    }
    for (const p of removed) if (!renamedFrom.has(p)) out.push({ filename: p, status: "removed", sha: this.blobSha(from.get(p)!) });
    for (const [p, text] of to) if (from.has(p) && from.get(p) !== text) out.push({ filename: p, status: "modified", sha: this.blobSha(text) });
    return out;
  }

  private commitJson(c: FakeCommit) {
    return { sha: c.sha, commit: { message: c.message, author: { name: c.author.name, email: c.author.email, date: c.at } } };
  }

  private changed(c: FakeCommit) {
    return this.diff(c.parent ? this.commits.get(c.parent)!.files : new Map(), c.files);
  }

  private blobs(): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of this.commits.values()) for (const text of c.files.values()) out.set(this.blobSha(text), text);
    return out;
  }

  /** The `fetch` the client is given. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.log.push(`${method} ${url.pathname}${url.search}`);
    const headers = new Headers(init?.headers);
    const quota = () => ({
      "x-ratelimit-limit": String(this.limit),
      "x-ratelimit-remaining": String(Math.max(0, --this.remaining)),
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": url.pathname === "/graphql" ? "graphql" : "core",
    });
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...quota(), ...extra } });
    const fail = this.failNext.shift();
    if (fail) return json(fail.status, { message: "failed" }, fail.headers);
    if (!headers.get("authorization")?.startsWith("Bearer ")) return json(401, { message: "no token" });

    if (url.pathname === "/graphql") {
      const query = JSON.parse(String(init?.body)).query as string;
      const data: Record<string, unknown> = {};
      for (const m of query.matchAll(/(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)) {
        const pr = this.pulls.get(`https://github.com/${m[2]}/${m[3]}/pull/${m[4]}`);
        data[m[1]!] = pr ? { pullRequest: { state: pr.state, isDraft: pr.isDraft ?? false, title: pr.title } } : null;
      }
      return json(200, { data });
    }
    const base = `/repos/${this.owner}/${this.name}`;
    // GitHub's owner and repository names are case-insensitive.
    if (this.deleted || !url.pathname.toLowerCase().startsWith(base.toLowerCase())) return json(404, { message: "Not Found" });
    const rest = url.pathname.slice(base.length);
    if (rest === "") return json(200, { name: this.name, owner: { login: this.owner }, default_branch: this.defaultBranch });
    if (rest === `/git/ref/heads/${this.defaultBranch}`) {
      const etag = `"${this.head}"`;
      if (headers.get("if-none-match") === etag) return json(304, null, { etag });
      return json(200, { object: { sha: this.head, type: "commit" } }, { etag });
    }
    if (rest.startsWith("/git/ref/heads/")) return json(404, { message: "Not Found" });
    let m = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest);
    if (m) {
      const [baseSha, headSha] = [m[1]!, m[2]!];
      if (!this.commits.has(baseSha) || !this.commits.has(headSha)) return json(404, { message: "Not Found" });
      const line = this.ancestors(headSha);
      const at = line.indexOf(baseSha);
      if (at === -1) return json(200, { status: "diverged", total_commits: 0, commits: [], files: [] });
      if (at === 0) return json(200, { status: "identical", total_commits: 0, commits: [], files: [] });
      const range = line.slice(0, at).reverse().map((s) => this.commits.get(s)!);
      return json(200, {
        status: "ahead",
        total_commits: range.length,
        commits: range.map((c) => this.commitJson(c)),
        files: this.diff(this.commits.get(baseSha)!.files, this.commits.get(headSha)!.files),
      });
    }
    m = /^\/commits\/([0-9a-f]+)$/.exec(rest);
    if (m) {
      const c = this.commits.get(m[1]!);
      return c ? json(200, { ...this.commitJson(c), files: this.changed(c) }) : json(404, { message: "Not Found" });
    }
    if (rest === "/commits") {
      const from = url.searchParams.get("sha")!;
      const path = url.searchParams.get("path")!;
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const touching = this.ancestors(from)
        .map((s) => this.commits.get(s)!)
        .filter((c) => this.changed(c).some((f) => f.filename === path || f.filename.startsWith(`${path}/`) || f.previous_filename === path || f.previous_filename?.startsWith(`${path}/`)));
      return json(200, touching.slice((page - 1) * perPage, page * perPage).map((c) => this.commitJson(c)));
    }
    m = /^\/git\/trees\/(.+)$/.exec(rest);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const dir = /^tree-([0-9a-f]+)-(.+)$/.exec(id);
      const commit = this.commits.get(dir ? dir[1]! : id);
      if (!commit) return json(404, { message: "Not Found" });
      const prefix = dir ? `${dir[2]}/` : "";
      const entries = new Map<string, { path: string; type: string; sha: string }>();
      for (const [path, text] of commit.files) {
        if (!path.startsWith(prefix)) continue;
        const name = path.slice(prefix.length);
        const slash = name.indexOf("/");
        if (slash === -1) entries.set(name, { path: name, type: "blob", sha: this.blobSha(text) });
        else entries.set(name.slice(0, slash), { path: name.slice(0, slash), type: "tree", sha: `tree-${commit.sha}-${prefix}${name.slice(0, slash)}` });
      }
      return json(200, { sha: id, tree: [...entries.values()], truncated: false });
    }
    m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest);
    if (m) {
      const text = this.blobs().get(m[1]!);
      return text === undefined ? json(404, { message: "Not Found" }) : json(200, { sha: m[1], encoding: "base64", content: Buffer.from(text).toString("base64") });
    }
    return json(404, { message: "Not Found" });
  };

  /** Requests made since the last call, then forgets them. */
  take(): string[] {
    const out = this.log;
    this.log = [];
    return out;
  }
}
