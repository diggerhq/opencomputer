#!/usr/bin/env python3
"""Read deploy/microvm/images.json for release.sh.

A separate file rather than heredocs inside the shell script: the first version
embedded these as heredocs inside process substitution, which `bash -n` accepts
and bash then refuses at run time with "bad substitution". The failure came
after the ownership guard had already been written and reviewed, which is the
worst place to discover a quoting bug.

Subcommands print plain lines for the shell to read.
"""
import json
import re
import subprocess
import sys

HERE = __file__.rsplit("/", 1)[0]
MANIFEST = f"{HERE}/images.json"
CLIENT_GO = f"{HERE}/../../internal/awsvm/client.go"


def delivered_default_mb():
    """awsvm's deliveredMicrovmMemoryMB — what metering prices the default on.

    Read from the source rather than duplicated here. The two drifting is the
    bug this guards: the constant was raised 2048 -> 4096 on 2026-08-24 and the
    lite images stayed at 2048, so every default create was metered for memory
    it did not get.
    """
    m = re.search(r"deliveredMicrovmMemoryMB\s*=\s*(\d+)", open(CLIENT_GO).read())
    if not m:
        sys.exit("could not read deliveredMicrovmMemoryMB from internal/awsvm/client.go")
    return int(m.group(1))


def load(env):
    m = json.load(open(MANIFEST))
    e = m["environments"].get(env)
    if not e:
        sys.exit(f"unknown environment {env!r}; have: {', '.join(m['environments'])}")
    # Ownership guard. This account also serves the blue serverless-agent
    # runtime (managed-agents-*), blue-* experiments, and osb-tpl-* images built
    # per customer template at run time. A name outside our prefix means the
    # manifest points at another product's runtime, and publishing would replace
    # the image its boxes boot from. Refuse before anything is built.
    prefix = m.get("ownedPrefix", "")
    stray = [i["name"] for i in e["images"] if not i["name"].startswith(prefix)]
    if stray:
        sys.exit(f"refusing: not ours (must start with {prefix!r}): {', '.join(stray)}")
    return m, e


def guest_hash():
    """A hash of everything that ends up in the guest image.

    Not a hash of the artifact zip: zip stores mtimes, so two builds of
    identical code differ. Not a path filter either — that was the first
    attempt, and it was already wrong: the guest binaries import ten packages
    under internal/ (agent, secretsproxy, sandbox, crypto, storage, blobstore,
    db, diskpolicy, logship, wsconn), so a change to any of them rebuilds the
    guest while touching nothing the filter watched.

    So ask the compiler. `go list -deps` yields the real closure for both
    binaries; hash every .go file in the packages belonging to this module,
    plus the Dockerfile and build.sh that shape the image. Deterministic,
    machine-independent, and it extends itself when a new dependency appears.
    """
    import hashlib
    import os
    root = os.path.abspath(f"{HERE}/../..")
    mod = subprocess.run(["go", "list", "-m"], cwd=root, capture_output=True,
                         text=True, check=True).stdout.strip()
    pkgs = subprocess.run(
        ["go", "list", "-deps", "-f", "{{.Dir}}|{{.ImportPath}}",
         "./cmd/agent", "./cmd/microvm-hooks"],
        cwd=root, capture_output=True, text=True, check=True).stdout.splitlines()
    files = []
    for line in pkgs:
        d, _, ip = line.partition("|")
        if not ip.startswith(mod) or not d:
            continue  # stdlib and third-party are pinned by go.sum, not by us
        for f in sorted(os.listdir(d)):
            if f.endswith(".go") and not f.endswith("_test.go"):
                files.append(os.path.join(d, f))
    files += [f"{HERE}/Dockerfile", f"{HERE}/build.sh"]
    h = hashlib.sha256()
    for f in sorted(set(files)):
        rel = os.path.relpath(f, root)
        h.update(rel.encode())
        h.update(open(f, "rb").read())
    return h.hexdigest()[:16]


def published_hash(region, acct, name):
    """The guest hash stamped on an image, or None. The image API has no tags,
    so the stamp rides in --description."""
    out = subprocess.run(
        ["aws", "lambda-microvms", "get-microvm-image",
         "--image-identifier", arn(region, acct, name), "--region", region,
         "--query", "description", "--output", "text"],
        capture_output=True, text=True)
    desc = out.stdout.strip()
    m = re.search(r"guest=([0-9a-f]{16})", desc or "")
    return m.group(1) if m else None


def account():
    return subprocess.run(
        ["aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text"],
        capture_output=True, text=True, check=True).stdout.strip()


def arn(region, acct, name):
    return f"arn:aws:lambda:{region}:{acct}:microvm-image:{name}"


def main():
    cmd, env = sys.argv[1], sys.argv[2]
    m, e = load(env)
    region = m["region"]

    if cmd == "config":
        print(region, m["artifactBucket"], e["artifactKey"])

    elif cmd == "images":
        for i in e["images"]:
            print(i["name"], i["memoryMB"])

    elif cmd == "check-memory":
        # Two different checks, and the first one is the one that was missing.
        #
        # 1. The DEFAULT image must deliver what metering prices it at. This is
        #    an invariant against the code, not against the live image — asking
        #    only "does the manifest match what is published" happily confirms a
        #    value that was wrong when it was published, which is how 2048
        #    survived a review.
        expected = delivered_default_mb()
        default = next((i for i in e["images"] if i.get("default")), None)
        if default and int(default["memoryMB"]) != expected:
            sys.exit(
                f"refusing: default tier {default['name']} is {default['memoryMB']}MiB "
                f"but awsvm meters the default at {expected}MiB — every default "
                f"create would be billed for memory it does not get")
        print(f"  default tier matches awsvm deliveredMicrovmMemoryMB ({expected}MiB)")

        # 2. No tier silently changes size. A deliberate resize needs
        #    MICROVM_ALLOW_RESIZE=1, so it cannot ride along with a code rebuild.
        import os
        allow_resize = os.environ.get("MICROVM_ALLOW_RESIZE") == "1"
        acct, bad = account(), []
        for i in e["images"]:
            out = subprocess.run(
                ["aws", "lambda-microvms", "list-microvm-image-versions",
                 "--image-identifier", arn(region, acct, i["name"]),
                 "--region", region,
                 "--query", "items[0].resources[0].minimumMemoryInMiB",
                 "--output", "text"], capture_output=True, text=True)
            live = out.stdout.strip()
            if live in ("", "None", "null"):
                print(f"  {i['name']}: new image, will be created at {i['memoryMB']}MiB")
            elif int(live) != int(i["memoryMB"]):
                bad.append(f"  {i['name']}: live={live}MiB manifest={i['memoryMB']}MiB")
            else:
                print(f"  {i['name']}: {live}MiB (matches)")
        if bad and not allow_resize:
            print("\nREFUSING — manifest memory does not match the live image:")
            print("\n".join(bad))
            print("\nIf this resize is intended, re-run with MICROVM_ALLOW_RESIZE=1.")
            sys.exit(1)
        if bad:
            print("\nMICROVM_ALLOW_RESIZE=1 — resizing:")
            print("\n".join(bad))

    elif cmd == "cp-config":
        acct = account()
        imgs = e["images"]
        default = next((i for i in imgs if i.get("default")), imgs[0])
        print(f"OPENSANDBOX_MICROVM_IMAGE_ARN={arn(region, acct, default['name'])}")
        tiers = [i for i in imgs if not i.get("default")]
        if tiers:
            print("OPENSANDBOX_MICROVM_SIZE_IMAGES=" + ",".join(
                f"{i['memoryMB']}={arn(region, acct, i['name'])}" for i in tiers))
        else:
            print("# no size tiers — leave OPENSANDBOX_MICROVM_SIZE_IMAGES unset")
    elif cmd == "guest-hash":
        print(guest_hash())

    elif cmd == "check-drift":
        # Exact: what this checkout would build vs what each image was built
        # from. Catches a bypassed CI run and a dependency nobody thought to
        # watch, both of which a path filter misses.
        want, acct, stale = guest_hash(), account(), []
        print(f"  guest source hash: {want}")
        for i in e["images"]:
            got = published_hash(region, acct, i["name"])
            if got == want:
                print(f"  {i['name']}: current")
            else:
                stale.append(i["name"])
                print(f"  {i['name']}: STALE (published from {got or 'unstamped'})")
        if stale:
            print(f"\n{len(stale)} image(s) behind this checkout: {', '.join(stale)}")
            print("Run: ./deploy/microvm/release.sh " + env)
            sys.exit(1)

    else:
        sys.exit(f"unknown subcommand {cmd!r}")


if __name__ == "__main__":
    main()
