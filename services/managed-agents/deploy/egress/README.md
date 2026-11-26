# Fixed egress exits

Static, customer-allowlistable outbound IPs for Modal tool sandboxes in regions
Modal Proxy does not cover (work 073). Each exit is a
Fly app (`oc-exit-<region>-<n>`) with a dedicated egress IPv4 that survives
deploys and machine replacement. A sandbox tunnels all its traffic to an exit
(a sing-box TUN client, VLESS+REALITY) and Modal's allowlist holds only the exit IPs,
so it fails closed.

## Files

- `exits.json`: Fly org, REALITY decoy, and per pool (`au`, `iad`, ...) the
  Fly region and exit count. Pools are internal: customers name a deployment
  region in `fixed_ips`, and `FIXED_IPS_POOLS` in `src/egress-exit.ts` maps
  each to a pool. A new pool needs an entry there.
- `apply.sh`: reconciles `exits.json` into Fly apps (app, dedicated inbound
  IPv4, egress IPv4, secrets, deploy) and writes `src/egress-registry.json`.
- `src/egress-registry.json` (under `src/` so the build output keeps its
  root): every exit's region, inbound IP, ports, egress IP and
  REALITY public key and short id. Public values only; the control plane
  serves it to the shim and as the public IP list.
- `test/`: unit tests for `egress.py` and a live smoke test (see Tests).
- `server/`: the exit image, Xray plus `egress.py`, a supervisor that starts
  Xray and every minute applies policy and credential changes through Xray's
  local API (users and routing rules). Nothing is reloaded, so open tunnels
  survive changes.

## How an exit enforces a deployment

- **Credential:** a deployment's VLESS UUID is
  `HMAC-SHA256(root_key, "oc-egress/v1/<deployment>/<UTC day>")`, first 16
  bytes as a v4 UUID (`egress.py credential`). The control plane derives it at
  sandbox create; the exit derives the same set itself, so nothing
  per-deployment is stored. It accepts yesterday, today and tomorrow (UTC),
  so a credential lives 2 to 3 days.
- **Root keys:** `EGRESS_ROOT_KEYS`, comma-separated hex, current first; all
  listed generations are accepted. Rotate by prepending a key, switching the
  control plane, then dropping the old one after a day.
- **Policy:** `EGRESS_POLICY` is
  `{"deployments": {"<id>": null | {"domains": [...], "cidrs": [...]}}}`, with
  the same entries and meaning as the deployment's Modal allowlist, platform
  hosts included. `null` is an open network. With `EGRESS_POLICY_URL` (set by
  `apply.sh` from `EGRESS_EDGE`), the exit polls its region's deployments
  from the edge every minute (`GET /internal/egress/policy?region=`, bearer
  `EGRESS_FETCH_TOKEN`, ETag) and keeps the last good answer when a poll
  fails. `EGRESS_POLICY` (the smoke deployments) stays enforced on top.
  The edge keys deployments by `exitIdentity` (a hash of account and
  deployment) and lists the fixed IPs publicly at `GET /v1/egress-ips`.
- **Rules:** IPv6 and private destinations are always refused. CIDRs match
  any port. Domains (exact or `*.`, which matches subdomains only) are 443
  only, as on Modal. Xray sniffs the TLS SNI (or HTTP Host) and dials the
  sniffed name itself, so a client cannot pair an allowed SNI with another
  address. Names resolve to IPv4 only. Everything else is refused.
- **DNS** does not go through the exit: sandboxes use Modal's resolver
  (`172.21.0.1`), excluded from the tunnel.

## Run

```sh
EGRESS_ROOT_KEYS=<hex> EGRESS_POLICY='{"deployments":{...}}' ./apply.sh [region]
```

Needs `fly` (logged in, or `FLY_API_TOKEN`), `sing-box` (REALITY key
generation) and `jq`. Re-runnable;
existing REALITY keys are kept (the private key exists only as a Fly secret).
To have exits poll the edge, add
`EGRESS_EDGE=https://managedagents.opencomputer.dev EGRESS_FETCH_TOKEN=<token>`;
the edge needs the same token in `EGRESS_FETCH_TOKENS` (comma-separated,
current first, for rotation), a GitHub Actions secret on this repository that
the production deploy installs on the edge Worker. To rotate: set
`EGRESS_FETCH_TOKENS=<new>,<old>` and deploy, re-run `apply.sh` with the new
token, then set it to `<new>` and deploy again.

## Tests

```sh
python3 -m unittest discover -s deploy/egress/test            # egress.py; xray on PATH adds a config check
EGRESS_LIVE=1 python3 -m unittest discover -s deploy/egress/test  # plus a local exit: live policy change mid-download
EGRESS_ROOT_KEYS=<hex> python3 deploy/egress/test/smoke.py \
  [--exit oc-exit-au-1] [--modal]                             # a live exit
```

`smoke.py` derives credentials for the smoke deployments in `test/policy.json`
(`apply.sh` adds them to every exit) and checks, through local sing-box
clients: allowlisted domains and CIDRs pass, everything else is refused, an
SNI paired with another destination still lands on the allowed host, the open
deployment leaves from the registry's egress IP, private ranges and stale
credentials are refused. With `--modal` (needs the `modal` package and a
token) it repeats the main cases from a sandbox whose Modal allowlist holds
only the exit IP, with DNS through Modal's resolver outside the tunnel, and
checks that a protocol where the server speaks first (SSH) is not held up by
sniffing.
