"""The exit: runs Xray (VLESS+REALITY) and keeps its users and rules in step
with the policy and the date, live, through Xray's local API. Nothing is ever
reloaded, so open tunnels survive policy changes and credential rollover.

Inputs (Fly secrets and env):
  EGRESS_ROOT_KEYS     comma-separated hex keys, current first. Every listed
                       generation is accepted, so rotation is: prepend the new
                       key, switch the control plane, drop the old one later.
  EGRESS_POLICY_URL    the control plane's policy for this exit's region
                       (/internal/egress/policy?region=...), polled every
                       minute with EGRESS_FETCH_TOKEN and an ETag. On a failed
                       poll the exit keeps enforcing the last good answer.
  EGRESS_POLICY        static deployments, always enforced on top of the
                       polled ones (apply.sh puts the smoke deployments here).
  Both are {"deployments": {"<id>": null | {"domains": [...], "cidrs": [...]}}}:
  null is an open network; a list pair is the deployment's allowlist,
  platform hosts included (the control plane merges them, as for Modal).
  REALITY_PRIVATE_KEY, REALITY_SHORT_ID, REALITY_DECOY

Credentials: a deployment's VLESS UUID is derived per UTC day from a root key
(`credential`), so no per-deployment secret is stored and a leaked one expires.
The exit accepts yesterday, today and tomorrow.

Enforcement: Xray sniffs TLS SNI and HTTP Host and dials the sniffed name
itself (destination override), so an allowed SNI sent to another address still
lands on the allowed host. Domains are 443 only, as on Modal
(deployment-egress.ts); CIDRs match any port, and a sniffed name must resolve
into them. IPv6 and private destinations are always refused; names resolve to
IPv4 only, since the egress IP customers allowlist is IPv4.

  python3 egress.py run                     render, start Xray, sync every minute
  python3 egress.py config                  print the Xray config for the current policy
  python3 egress.py credential <id> [day]   print a deployment's UUID (current key)
"""

import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

XRAY = os.environ.get("XRAY", "xray")
API = os.environ.get("XRAY_API", "127.0.0.1:10085")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "443"))
POLICY_FILE = os.environ.get("POLICY_FILE", "/run/egress/policy.json")
INBOUND = "vless-in"
DNS_TAG = "dns-internal"
SYNC_SECONDS = int(os.environ.get("EGRESS_SYNC_SECONDS", "60"))
POLICY_URL = os.environ.get("EGRESS_POLICY_URL", "")
DOMAIN = re.compile(r"^(\*\.)?([a-z0-9-]{1,63}\.)+[a-z0-9-]{1,63}$")
BLOCKED = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
           "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3", "::/0"]


def credential(key_hex: str, deployment_id: str, day: dt.date) -> str:
    """The VLESS UUID for a deployment on a UTC day. Mirrored by src/egress-exit.ts."""
    mac = hmac.new(bytes.fromhex(key_hex), f"oc-egress/v1/{deployment_id}/{day.isoformat()}".encode(), hashlib.sha256)
    return str(uuid.UUID(bytes=mac.digest()[:16], version=4))


def window(now: dt.datetime) -> list[dt.date]:
    today = now.astimezone(dt.timezone.utc).date()
    return [today + dt.timedelta(days=d) for d in (-1, 0, 1)]


def keys() -> list[str]:
    out = [k.strip() for k in os.environ["EGRESS_ROOT_KEYS"].split(",") if k.strip()]
    if not out or any(len(bytes.fromhex(k)) < 32 for k in out):
        sys.exit("EGRESS_ROOT_KEYS: need at least one key of 32+ bytes, hex")
    return out


def parse_policy(text: str) -> dict:
    deployments = json.loads(text or '{"deployments": {}}')["deployments"]
    for dep, allow in deployments.items():
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", dep):
            raise ValueError(f"bad deployment id {dep!r}")
        if allow is None:
            continue
        for d in allow.get("domains", []):
            if not DOMAIN.match(d):
                raise ValueError(f"{dep}: bad domain {d!r}")
        for c in allow.get("cidrs", []):
            ipaddress.ip_network(c, strict=False)
    return dict(sorted(deployments.items()))


def xray_domain(d: str) -> str:
    """`*.example.com` matches subdomains only, as on Modal."""
    if d.startswith("*."):
        return "regexp:^.+\\." + re.escape(d[2:]) + "$"
    return "full:" + d


def desired(policy: dict, now: dt.datetime) -> tuple[dict[str, str], list[dict]]:
    """Users (email -> UUID) and routing rules for a policy at a moment."""
    users = {}
    rules = [{"ruleTag": "dns", "inboundTag": [DNS_TAG], "outboundTag": "direct"},  # Xray's own lookups
             {"ruleTag": "blocked", "ip": BLOCKED, "outboundTag": "block"}]
    for dep, allow in policy.items():
        emails = []
        for key in keys():
            gen = hashlib.sha256(bytes.fromhex(key)).hexdigest()[:8]
            for day in window(now):
                email = f"{dep}/{day.isoformat()}/{gen}"
                users[email] = credential(key, dep, day)
                emails.append(email)
        if allow is None:
            rules.append({"ruleTag": f"{dep}/open", "user": emails, "outboundTag": "direct"})
            continue
        if allow.get("cidrs"):
            rules.append({"ruleTag": f"{dep}/cidrs", "user": emails, "ip": allow["cidrs"], "outboundTag": "direct"})
        if allow.get("domains"):
            rules.append({"ruleTag": f"{dep}/domains", "user": emails, "network": "tcp", "port": "443",
                          "domain": [xray_domain(d) for d in allow["domains"]], "outboundTag": "direct"})
    return users, rules  # anything unmatched goes to the first outbound, block


def client(email: str, uid: str) -> dict:
    return {"id": uid, "email": email, "flow": "xtls-rprx-vision"}


def inbound(users: dict[str, str]) -> dict:
    decoy = os.environ.get("REALITY_DECOY", "addons.mozilla.org")
    return {
        "tag": INBOUND, "listen": "0.0.0.0", "port": LISTEN_PORT, "protocol": "vless",
        "settings": {"clients": [client(e, u) for e, u in users.items()], "decryption": "none"},
        "streamSettings": {"network": "tcp", "security": "reality", "realitySettings": {
            "target": f"{decoy}:443", "serverNames": [decoy],
            "privateKey": os.environ["REALITY_PRIVATE_KEY"], "shortIds": [os.environ["REALITY_SHORT_ID"]]}},
        "sniffing": {"enabled": True, "destOverride": ["tls", "http"], "routeOnly": False},
    }


def config(policy: dict, now: dt.datetime) -> dict:
    users, rules = desired(policy, now)
    return {
        "log": {"loglevel": "warning", "access": "none"},
        "api": {"tag": "api", "listen": API, "services": ["HandlerService", "RoutingService"]},
        "dns": {"tag": DNS_TAG, "servers": ["1.1.1.1", "1.0.0.1"], "queryStrategy": "UseIPv4"},
        "inbounds": [inbound(users)],
        "outbounds": [{"tag": "block", "protocol": "blackhole"},
                      {"tag": "direct", "protocol": "freedom", "settings": {"domainStrategy": "UseIPv4"}}],
        # IPOnDemand resolves sniffed names so the blocked ranges and CIDRs see their IPs.
        "routing": {"domainStrategy": "IPOnDemand", "rules": rules},
    }


def api(*args: str, payload: dict | None = None) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
        cmd = [XRAY, "api", args[0], f"--server={API}", *args[1:]]
        if payload is not None:
            json.dump(payload, f)
            f.flush()
            cmd.append(f.name)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            raise RuntimeError(f"xray api {args[0]}: {(r.stdout + r.stderr).strip()}")


def sync(applied: tuple[dict, list], policy: dict, now: dt.datetime) -> tuple[dict, list]:
    """Applies the difference between what Xray has and what it should have.
    Users are added before rules and removed after, so no rule names a
    missing user."""
    have_users, have_rules = applied
    users, rules = desired(policy, now)
    added = {e: u for e, u in users.items() if have_users.get(e) != u}
    removed = [e for e in have_users if e not in users or e in added]
    if removed:
        api("rmu", f"-tag={INBOUND}", *removed)
    if added:
        api("adu", payload={"inbounds": [inbound(added)]})
    if rules != have_rules:
        api("adrules", payload={"routing": {"rules": rules}})  # replaces the whole set
    if added or removed or rules != have_rules:
        print(f"synced: +{len(added)} -{len(removed)} users, {len(rules)} rules", flush=True)
    return users, rules


def fetch_policy(etag: str | None) -> str | None:
    """Polls the control plane: the policy unless unchanged (None), validated
    and saved to POLICY_FILE, which the sync reads."""
    # Cloudflare refuses Python's default user agent (error 1010).
    request = urllib.request.Request(POLICY_URL, headers={
        "authorization": f"Bearer {os.environ['EGRESS_FETCH_TOKEN']}",
        "user-agent": "oc-egress-exit/1",
        **({"if-none-match": etag} if etag else {})})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            text, etag = response.read().decode(), response.headers.get("etag")
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return None
        raise RuntimeError(f"policy fetch: HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"policy fetch: {e}") from e
    parse_policy(text)
    tmp = POLICY_FILE + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, POLICY_FILE)
    return etag or ""


def current_policy() -> dict:
    """The polled deployments (last good copy) plus the static ones."""
    polled = parse_policy(open(POLICY_FILE).read()) if os.path.exists(POLICY_FILE) else {}
    return dict(sorted({**polled, **parse_policy(os.environ.get("EGRESS_POLICY", ""))}.items()))


def run() -> None:
    os.makedirs(os.path.dirname(POLICY_FILE), mode=0o700, exist_ok=True)
    etag = None
    if POLICY_URL:
        try:
            etag = fetch_policy(None)
        except (OSError, ValueError, RuntimeError) as e:
            print(f"policy fetch failed at boot, starting with the last good copy: {e}", file=sys.stderr, flush=True)
    policy = current_policy()
    now = dt.datetime.now(dt.timezone.utc)
    conf = os.path.join(os.path.dirname(POLICY_FILE), "xray.json")
    with open(os.open(conf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(config(policy, now), f)
    xray = subprocess.Popen([XRAY, "run", "-c", conf])
    applied = desired(policy, now)
    while True:
        time.sleep(SYNC_SECONDS)
        if xray.poll() is not None:
            sys.exit(f"xray exited with {xray.returncode}")
        try:
            if POLICY_URL:
                etag = fetch_policy(etag) or etag
            applied = sync(applied, current_policy(), dt.datetime.now(dt.timezone.utc))
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as e:
            # Keep serving the last good state; the next round retries.
            print(f"sync failed: {e}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "credential":
        day = dt.date.fromisoformat(sys.argv[3]) if len(sys.argv) > 3 else dt.datetime.now(dt.timezone.utc).date()
        print(credential(keys()[0], sys.argv[2], day))
    elif cmd == "config":
        print(json.dumps(config(parse_policy(os.environ.get("EGRESS_POLICY", "")), dt.datetime.now(dt.timezone.utc)), indent=1))
    else:
        run()
