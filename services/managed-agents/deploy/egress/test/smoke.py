"""Live checks against a deployed exit, from here and from a Modal sandbox.

  EGRESS_ROOT_KEYS=<hex> python3 deploy/egress/test/smoke.py [--exit oc-exit-au-1] [--modal]

The exit must carry the smoke deployments in test/policy.json (apply.sh always
adds them). Local checks need sing-box and curl; --modal also needs the modal
package and a Modal token, and runs a sandbox whose Modal allowlist holds only
the exit's IP, with the tunnel set up as blue's sandboxes will set it up.
Exits non-zero if any check fails.
"""

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
import egress  # noqa: E402

MODAL_DNS = "172.21.0.1"  # Modal's resolver; stays outside the tunnel
SING_BOX_VERSION = "1.14.0"  # the sandbox client, as in blue's sandbox image
GITHUB_IP = "140.82.112.4"  # not example.com's host: a spoof that lands here fails TLS


def curl(*args):
    return ["curl", "-s", "-m", "10", *args]


def outbound(e, uuid, tag="proxy"):
    r = e["reality"]
    return {"type": "vless", "tag": tag, "server": e["server"], "server_port": 443, "uuid": uuid,
            "flow": "xtls-rprx-vision",
            "tls": {"enabled": True, "server_name": r["server_name"], "utls": {"enabled": True, "fingerprint": "chrome"},
                    "reality": {"enabled": True, "public_key": r["public_key"], "short_id": r["short_id"]}}}


def socks_client(e, uuid, port):
    return {"log": {"level": "warn"}, "inbounds": [{"type": "socks", "listen": "127.0.0.1", "listen_port": port}],
            "outbounds": [outbound(e, uuid)]}


def tun_client(e, uuid):
    return {"log": {"level": "warn"},
            "inbounds": [{"type": "tun", "tag": "tun-in", "address": ["172.19.0.1/30"], "mtu": 1400,
                          "auto_route": True, "strict_route": True, "route_exclude_address": [f"{MODAL_DNS}/32"]}],
            "outbounds": [outbound(e, uuid)], "route": {"auto_detect_interface": True, "final": "proxy"}}


def local_checks(e):
    allow, cidr, open_, stale = (f"socks5h://127.0.0.1:{p}" for p in (21081, 21082, 21083, 21084))
    allow_ip_dest = "socks5://127.0.0.1:21081"  # curl resolves, so the exit gets an IP destination
    return [
        ("allow: example.com", curl("-x", allow, "https://example.com"), "ok"),
        ("allow: api.github.com (*.github.com)", curl("-x", allow, "https://api.github.com"), "ok"),
        ("allow: 1.1.1.1 (cidr)", curl("-x", allow, "https://1.1.1.1"), "ok"),
        ("allow: github.com apex refused", curl("-x", allow, "https://github.com"), "refused"),
        ("allow: ipinfo.io refused", curl("-x", allow, "https://ipinfo.io/ip"), "refused"),
        ("allow: port 80 refused", curl("-x", allow, "http://example.com"), "refused"),
        ("spoof control: SNI example.com to GitHub IP, direct",
         curl("--resolve", f"example.com:443:{GITHUB_IP}", "https://example.com"), "refused"),
        ("spoof: SNI example.com to GitHub IP lands on example.com",
         curl("-x", allow_ip_dest, "--resolve", f"example.com:443:{GITHUB_IP}", "https://example.com"), "ok"),
        ("spoof: SNI example.com to ipinfo.io lands on example.com",
         curl("-x", allow, "--connect-to", "example.com:443:ipinfo.io:443", "https://example.com"), "ok"),
        ("cidr: 8.8.8.8", curl("-x", cidr, "https://8.8.8.8"), "ok"),
        ("cidr: example.com refused", curl("-x", cidr, "https://example.com"), "refused"),
        ("open: egress IP", curl("-x", open_, "https://ipinfo.io/ip"), ("eq", e["egress_ipv4"])),
        ("open: private 10.0.0.1 refused", curl("-x", open_, "-k", "https://10.0.0.1"), "refused"),
        ("open: metadata 169.254.169.254 refused", curl("-x", open_, "http://169.254.169.254"), "refused"),
        ("stale credential (8 days) refused", curl("-x", stale, "https://example.com"), "refused"),
    ]


def sandbox_checks(e, phase):
    dig = ["dig", "+short", "+time=3", "+tries=1"]
    if phase == "none":  # Modal alone, before any tunnel: only the exit IP is reachable
        return [
            ("modal: resolver answers any name", dig + ["example.com"], "nonempty"),
            ("modal: direct DNS to 8.8.8.8 blocked", dig + ["example.com", "@8.8.8.8"], "empty"),
            ("modal: https example.com blocked", curl("https://example.com"), "refused"),
        ]
    if phase == "allow":
        return [
            ("modal allow: DNS resolves", dig + ["github.com"], "nonempty"),
            ("modal allow: example.com", curl("https://example.com"), "ok"),
            ("modal allow: api.github.com", curl("https://api.github.com"), "ok"),
            ("modal allow: ipinfo.io refused", curl("https://ipinfo.io/ip"), "refused"),
            ("modal allow: github.com apex refused", curl("https://github.com"), "refused"),
        ]
    return [
        ("modal open: egress IP", curl("https://ipinfo.io/ip"), ("eq", e["egress_ipv4"])),
        ("modal open: git ls-remote", ["git", "ls-remote", "https://github.com/git/git", "HEAD"], "nonempty"),
        ("modal open: SSH banner (server speaks first)",
         ["bash", "-c", f"timeout 8 bash -c 'exec 3<>/dev/tcp/{GITHUB_IP}/22; head -c 7 <&3'"], ("eq", "SSH-2.0")),
    ]


def verdict(expect, rc, out):
    out = out.strip()
    if expect == "ok":
        return rc == 0
    if expect == "refused":
        return rc != 0
    if expect == "nonempty":
        return rc == 0 and bool(out)
    if expect == "empty":
        return not out or rc != 0
    return rc == 0 and out == expect[1]


def report(results):
    failed = 0
    for name, expect, rc, out, ok in results:
        failed += not ok
        shown = out.strip().splitlines()[0][:60] if out.strip() else ""
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  (want {expect}, rc={rc}, out={shown!r})"))
    return failed


def run_local(e, creds):
    procs = []
    with tempfile.TemporaryDirectory() as d:
        try:
            for (port, uuid) in zip((21081, 21082, 21083, 21084), creds):
                path = f"{d}/{port}.json"
                pathlib.Path(path).write_text(json.dumps(socks_client(e, uuid, port)))
                procs.append(subprocess.Popen(["sing-box", "run", "-c", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            time.sleep(2)
            results = []
            for name, cmd, expect in local_checks(e):
                p = subprocess.run(cmd, capture_output=True, text=True)
                results.append((name, expect, p.returncode, p.stdout, verdict(expect, p.returncode, p.stdout)))
            return results
        finally:
            for p in procs:
                p.terminate()
                p.wait()


def run_modal(e, creds):
    import modal

    version = SING_BOX_VERSION
    url = f"https://github.com/SagerNet/sing-box/releases/download/v{version}/sing-box-{version}-linux-amd64.tar.gz"
    img = (modal.Image.debian_slim().apt_install("iproute2", "curl", "dnsutils", "git", "ca-certificates")
           .run_commands(f"curl -sL {url} | tar xz -C /tmp && mv /tmp/sing-box-{version}-linux-amd64/sing-box /usr/local/bin/"))
    app = modal.App.lookup("oc-egress-smoke", create_if_missing=True)
    secret = modal.Secret.from_dict({"TUN_ALLOW": json.dumps(tun_client(e, creds[0])),
                                     "TUN_OPEN": json.dumps(tun_client(e, creds[2]))})

    def phase_script(phase):
        lines = []
        for i, (_, cmd, _) in enumerate(sandbox_checks(e, phase)):
            lines.append(f'out=$({shlex.join(cmd)} 2>/dev/null); rc=$?; '
                         f'printf "%s\\t%s\\t%s\\n" {i} $rc "$(printf %s "$out" | head -c 200 | tr "\\n\\t" "  ")"')
        return "\n".join(lines)

    script = ["set +e", "echo '#phase none'", phase_script("none")]
    for phase, var in (("allow", "TUN_ALLOW"), ("open", "TUN_OPEN")):
        script += [f"echo '#phase {phase}'", f'printenv {var} > /tmp/{phase}.json',
                   f'sing-box run -c /tmp/{phase}.json > /tmp/{phase}.log 2>&1 & pid=$!; sleep 4',
                   phase_script(phase), 'kill $pid; wait $pid 2>/dev/null; sleep 2']

    sb = modal.Sandbox.create(app=app, image=img, runtime="vm", timeout=600, secrets=[secret],
                              outbound_cidr_allowlist=[f"{e['server']}/32"], outbound_domain_allowlist=[])
    try:
        p = sb.exec("bash", "-c", "\n".join(script), timeout=300)
        stdout = p.stdout.read()
    finally:
        sb.terminate()

    results, phase = [], None
    for line in stdout.splitlines():
        if line.startswith("#phase "):
            phase = line.split()[1]
            continue
        i, rc, out = (line.split("\t", 2) + [""])[:3]
        name, _, expect = sandbox_checks(e, phase)[int(i)]
        results.append((name, expect, int(rc), out, verdict(expect, int(rc), out)))
    want = sum(len(sandbox_checks(e, ph)) for ph in ("none", "allow", "open"))
    if len(results) != want:
        results.append(("modal: all checks reported", f"{want} results", len(results), stdout[-300:], False))
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--exit", help="app name from src/egress-registry.json (default: first)")
    ap.add_argument("--modal", action="store_true", help="also run the Modal sandbox checks")
    args = ap.parse_args()

    exits = json.loads((HERE.parents[2] / "src" / "egress-registry.json").read_text())["exits"]
    e = next((x for x in exits if x["app"] == args.exit), None) if args.exit else exits[0]
    if not e:
        sys.exit(f"no exit {args.exit!r} in src/egress-registry.json")
    for binary in ("sing-box", "curl"):
        if not shutil.which(binary):
            sys.exit(f"missing {binary}")
    key = egress.keys()[0]
    today = dt.datetime.now(dt.timezone.utc).date()
    creds = [egress.credential(key, "smoke-allow", today), egress.credential(key, "smoke-cidr", today),
             egress.credential(key, "smoke-open", today), egress.credential(key, "smoke-open", today - dt.timedelta(days=8))]

    print(f"exit {e['app']}: server {e['server']}, egress {e['egress_ipv4']}")
    results = run_local(e, creds)
    if args.modal:
        results += run_modal(e, creds)
    failed = report(results)
    print(f"\n{len(results) - failed}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
