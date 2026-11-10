"""Tests for server/egress.py.

  python3 -m unittest discover -s deploy/egress/test

Offline by default. With `xray` on PATH the rendered config is checked with
`xray run -test`. EGRESS_LIVE=1 (needs xray, sing-box, curl and the internet)
also runs a local exit and changes its policy under an open download.
"""

import datetime as dt
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
SERVER = HERE.parent / "server" / "egress.py"
sys.path.insert(0, str(SERVER.parent))
import egress  # noqa: E402

KEY_A = "11" * 32
KEY_B = "22" * 32
POLICY = (HERE / "policy.json").read_text()
ENV = {"EGRESS_ROOT_KEYS": KEY_A, "REALITY_PRIVATE_KEY": "priv", "REALITY_SHORT_ID": "abcd"}
NOW = dt.datetime(2026, 10, 19, 12, tzinfo=dt.timezone.utc)


def env(**extra):
    return mock.patch.dict(os.environ, {**ENV, **extra}, clear=True)


def rules(policy=POLICY, **extra):
    with env(**extra):
        return egress.desired(egress.parse_policy(policy), NOW)[1]


class Credential(unittest.TestCase):
    def test_matches_the_sandbox_side(self):
        # Same vector as test/egress-exit.test.ts.
        key = "00" * 16 + "ff" * 16
        self.assertEqual(egress.credential(key, "dep_abc", dt.date(2026, 10, 19)), "bafb45ae-7573-4839-900d-a177d0c57d72")

    def test_varies_by_key_deployment_and_day(self):
        day = dt.date(2026, 10, 19)
        base = egress.credential(KEY_A, "dep", day)
        self.assertNotEqual(base, egress.credential(KEY_B, "dep", day))
        self.assertNotEqual(base, egress.credential(KEY_A, "dep2", day))
        self.assertNotEqual(base, egress.credential(KEY_A, "dep", day + dt.timedelta(days=1)))

    def test_cli_prints_current_key_credential(self):
        with env(EGRESS_ROOT_KEYS=f"{KEY_A},{KEY_B}"):
            out = subprocess.run([sys.executable, str(SERVER), "credential", "dep", "2026-10-19"],
                                 capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(out, egress.credential(KEY_A, "dep", dt.date(2026, 10, 19)))


class Users(unittest.TestCase):
    def test_window_is_yesterday_today_tomorrow_utc(self):
        late = dt.datetime(2026, 10, 19, 23, 30, tzinfo=dt.timezone(dt.timedelta(hours=-5)))
        self.assertEqual(egress.window(late), [dt.date(2026, 10, 19), dt.date(2026, 10, 20), dt.date(2026, 10, 21)])

    def test_every_key_generation_and_day_is_accepted(self):
        with env(EGRESS_ROOT_KEYS=f"{KEY_A},{KEY_B}"):
            users, _ = egress.desired({"dep": None}, NOW)
        expected = {egress.credential(k, "dep", d) for k in (KEY_A, KEY_B) for d in egress.window(NOW)}
        self.assertEqual(set(users.values()), expected)

    def test_short_key_refused(self):
        with env(EGRESS_ROOT_KEYS="11" * 31), self.assertRaises(SystemExit):
            egress.keys()


class Policy(unittest.TestCase):
    def test_bad_entries_refused(self):
        for bad in ('{"deployments": {"a b": null}}',
                    '{"deployments": {"d": {"domains": ["*"]}}}',
                    '{"deployments": {"d": {"domains": ["Example.com"]}}}',
                    '{"deployments": {"d": {"cidrs": ["10.0.0.0/33"]}}}'):
            with self.subTest(bad), self.assertRaises(ValueError):
                egress.parse_policy(bad)

    def test_only_xrays_own_dns_precedes_the_blocked_ranges(self):
        dns, blocked = rules()[:2]
        self.assertEqual(dns, {"ruleTag": "dns", "inboundTag": ["dns-internal"], "outboundTag": "direct"})
        with env():
            self.assertEqual(egress.config(egress.parse_policy(POLICY), NOW)["dns"]["tag"], "dns-internal")
        self.assertEqual(blocked["ruleTag"], "blocked")

    def test_blocked_ranges_include_ipv6_and_private(self):
        first = rules()[1]
        self.assertEqual(first["outboundTag"], "block")
        for net in ("::/0", "10.0.0.0/8", "169.254.0.0/16", "127.0.0.0/8"):
            self.assertIn(net, first["ip"])

    def test_open_deployment_routes_everything_direct(self):
        open_ = [r for r in rules() if r["ruleTag"] == "smoke-open/open"]
        self.assertEqual(len(open_), 1)
        self.assertEqual(set(open_[0]) - {"ruleTag", "user"}, {"outboundTag"})

    def test_cidrs_any_port_domains_443_tcp(self):
        by_tag = {r["ruleTag"]: r for r in rules()}
        self.assertEqual(by_tag["smoke-cidr/cidrs"]["ip"], ["8.8.8.8/32"])
        self.assertNotIn("port", by_tag["smoke-cidr/cidrs"])
        dom = by_tag["smoke-allow/domains"]
        self.assertEqual((dom["network"], dom["port"]), ("tcp", "443"))
        self.assertIn("full:example.com", dom["domain"])
        self.assertNotIn("smoke-cidr/domains", by_tag)

    def test_wildcard_matches_subdomains_only(self):
        pattern = egress.xray_domain("*.github.com").removeprefix("regexp:")
        self.assertTrue(re.search(pattern, "api.github.com"))
        self.assertTrue(re.search(pattern, "a.b.github.com"))
        self.assertFalse(re.search(pattern, "github.com"))
        self.assertFalse(re.search(pattern, "evilgithub.com"))
        self.assertFalse(re.search(pattern, "api.github.com.evil.io"))

    def test_rules_name_only_own_users(self):
        with env():
            users, rs = egress.desired(egress.parse_policy(POLICY), NOW)
        for r in rs[2:]:
            dep = r["ruleTag"].split("/")[0]
            self.assertTrue(all(u.startswith(dep + "/") and u in users for u in r["user"]))


class Config(unittest.TestCase):
    def config(self):
        with env():
            return egress.config(egress.parse_policy(POLICY), NOW)

    def test_overrides_destination_with_sniffed_name(self):
        sniff = self.config()["inbounds"][0]["sniffing"]
        self.assertEqual(sniff, {"enabled": True, "destOverride": ["tls", "http"], "routeOnly": False})

    def test_ipv4_only_and_names_resolved_for_ip_rules(self):
        c = self.config()
        self.assertEqual(c["dns"]["queryStrategy"], "UseIPv4")
        self.assertEqual(c["routing"]["domainStrategy"], "IPOnDemand")
        self.assertEqual(c["outbounds"][1]["settings"]["domainStrategy"], "UseIPv4")

    def test_unmatched_traffic_is_blocked(self):
        self.assertEqual(self.config()["outbounds"][0]["protocol"], "blackhole")

    @unittest.skipUnless(shutil.which("xray"), "xray not on PATH")
    def test_xray_accepts_config(self):
        xray = shutil.which("xray")
        keys = subprocess.run([xray, "x25519"], capture_output=True, text=True, check=True).stdout
        priv = re.search(r"PrivateKey: (\S+)", keys).group(1)
        with env(REALITY_PRIVATE_KEY=priv), tempfile.TemporaryDirectory() as d:
            path = f"{d}/xray.json"
            pathlib.Path(path).write_text(json.dumps(egress.config(egress.parse_policy(POLICY), NOW)))
            subprocess.run([xray, "run", "-test", "-c", path], check=True, capture_output=True)


class Sync(unittest.TestCase):
    def test_day_rollover_adds_and_removes_one_day(self):
        policy = {"dep": None}
        calls = []
        with env(), mock.patch.object(egress, "api", lambda *a, payload=None: calls.append((a, payload))):
            applied = egress.desired(policy, NOW)
            egress.sync(applied, policy, NOW + dt.timedelta(days=1))
        (rmu, _), (adu, payload), (adrules, _) = calls
        self.assertEqual(rmu, ("rmu", "-tag=vless-in", "dep/2026-10-18/" + rmu[2].split("/")[2]))
        self.assertEqual(adu, ("adu",))
        self.assertEqual([c["email"].split("/")[1] for c in payload["inbounds"][0]["settings"]["clients"]], ["2026-10-21"])
        self.assertEqual(adrules, ("adrules",))

    def test_no_change_no_calls(self):
        calls = []
        with env(), mock.patch.object(egress, "api", lambda *a, payload=None: calls.append(a)):
            applied = egress.desired(egress.parse_policy(POLICY), NOW)
            egress.sync(applied, egress.parse_policy(POLICY), NOW + dt.timedelta(hours=1))
        self.assertEqual(calls, [])

    def test_users_added_before_rules_and_removed_first(self):
        calls = []
        with env(), mock.patch.object(egress, "api", lambda *a, payload=None: calls.append(a[0])):
            applied = egress.desired({"old": None}, NOW)
            egress.sync(applied, {"new": None}, NOW)
        self.assertEqual(calls, ["rmu", "adu", "adrules"])


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Poll(unittest.TestCase):
    """fetch_policy against a local server standing in for the control plane."""

    def setUp(self):
        import http.server
        import threading
        test = self
        self.answer = (200, POLICY, '"v1"')
        self.seen = []
        self.agents = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                test.seen.append((self.headers.get("authorization"), self.headers.get("if-none-match")))
                test.agents.append(self.headers.get("user-agent"))
                status, body, etag = test.answer
                if self.headers.get("if-none-match") == etag:
                    status, body = 304, ""
                self.send_response(status)
                self.send_header("etag", etag)
                self.end_headers()
                self.wfile.write(body.encode())

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.dir = tempfile.mkdtemp()
        url = f"http://127.0.0.1:{self.server.server_port}/internal/egress/policy?region=au"
        self.patches = [mock.patch.object(egress, "POLICY_URL", url),
                        mock.patch.object(egress, "POLICY_FILE", os.path.join(self.dir, "policy.json"))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.server.shutdown()
        shutil.rmtree(self.dir)

    def test_fetches_saves_and_honours_etag(self):
        with env(EGRESS_FETCH_TOKEN="tok"):
            self.assertEqual(egress.fetch_policy(None), '"v1"')
            self.assertEqual(egress.current_policy(), egress.parse_policy(POLICY))
            self.assertIsNone(egress.fetch_policy('"v1"'))
        self.assertEqual(self.seen, [("Bearer tok", None), ("Bearer tok", '"v1"')])
        self.assertEqual(self.agents, ["oc-egress-exit/1"] * 2)

    def test_bad_answers_keep_the_last_good_policy(self):
        with env(EGRESS_FETCH_TOKEN="tok"):
            egress.fetch_policy(None)
            self.answer = (200, '{"deployments": {"bad id!": null}}', '"v2"')
            self.assertRaises(ValueError, egress.fetch_policy, '"v1"')
            self.answer = (401, "", '"v3"')
            self.assertRaises(RuntimeError, egress.fetch_policy, '"v1"')
            self.assertEqual(egress.current_policy(), egress.parse_policy(POLICY))

    def test_static_deployments_stay_on_top_of_polled_ones(self):
        self.answer = (200, '{"deployments": {"polled": null}}', '"v1"')
        with env(EGRESS_FETCH_TOKEN="tok", EGRESS_POLICY='{"deployments": {"smoke-open": null}}'):
            egress.fetch_policy(None)
            self.assertEqual(list(egress.current_policy()), ["polled", "smoke-open"])


@unittest.skipUnless(os.environ.get("EGRESS_LIVE") == "1" and all(map(shutil.which, ("xray", "sing-box", "curl"))),
                     "set EGRESS_LIVE=1 with xray, sing-box and curl on PATH")
class Live(unittest.TestCase):
    """A local exit whose policy changes while a download is open."""

    def test_policy_changes_apply_live_without_dropping_connections(self):
        kp = subprocess.run(["sing-box", "generate", "reality-keypair"], capture_output=True, text=True, check=True).stdout
        priv, pub = (re.search(rf"{k}: (\S+)", kp).group(1) for k in ("PrivateKey", "PublicKey"))
        port, api, socks_a, socks_b = (free_port() for _ in range(4))
        a_allow = {"cidrs": ["1.1.1.1/32"], "domains": ["fsn1-speed.hetzner.com"]}
        today = dt.datetime.now(dt.timezone.utc).date()
        with tempfile.TemporaryDirectory() as d:
            policy_file = f"{d}/policy.json"

            def set_policy(deps):
                pathlib.Path(policy_file + ".tmp").write_text(json.dumps({"deployments": deps}))
                os.replace(policy_file + ".tmp", policy_file)

            set_policy({"live-a": a_allow})
            server_env = {**os.environ, "EGRESS_ROOT_KEYS": KEY_A, "REALITY_PRIVATE_KEY": priv, "REALITY_SHORT_ID": "abcd",
                          "REALITY_DECOY": "addons.mozilla.org", "LISTEN_PORT": str(port), "XRAY_API": f"127.0.0.1:{api}",
                          "POLICY_FILE": policy_file, "EGRESS_SYNC_SECONDS": "1"}
            server_env.pop("EGRESS_POLICY", None)
            procs = [subprocess.Popen([sys.executable, str(SERVER), "run"], env=server_env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
            for dep, socks in (("live-a", socks_a), ("live-b", socks_b)):
                conf = {"log": {"level": "error"},
                        "inbounds": [{"type": "socks", "listen": "127.0.0.1", "listen_port": socks}],
                        "outbounds": [{"type": "vless", "server": "127.0.0.1", "server_port": port,
                                       "uuid": egress.credential(KEY_A, dep, today), "flow": "xtls-rprx-vision",
                                       "tls": {"enabled": True, "server_name": "addons.mozilla.org",
                                               "utls": {"enabled": True, "fingerprint": "chrome"},
                                               "reality": {"enabled": True, "public_key": pub, "short_id": "abcd"}}}]}
                pathlib.Path(f"{d}/{dep}.json").write_text(json.dumps(conf))
                procs.append(subprocess.Popen(["sing-box", "run", "-c", f"{d}/{dep}.json"],
                                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))

            def get(socks, url):
                return subprocess.run(["curl", "-s", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}",
                                       "-x", f"socks5h://127.0.0.1:{socks}", url], capture_output=True, text=True).stdout

            try:
                time.sleep(3)
                self.assertEqual(get(socks_a, "https://1.1.1.1/cdn-cgi/trace"), "200")
                self.assertEqual(get(socks_a, "https://8.8.8.8"), "000")
                self.assertEqual(get(socks_b, "https://8.8.8.8"), "000")
                download = subprocess.Popen(
                    ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code} %{size_download}", "--limit-rate", "1M", "-m", "60",
                     "-x", f"socks5h://127.0.0.1:{socks_a}", "-r", "0-11999999", "https://fsn1-speed.hetzner.com/100MB.bin"],
                    stdout=subprocess.PIPE, text=True)
                time.sleep(2)
                set_policy({"live-a": {**a_allow, "cidrs": ["1.1.1.1/32", "8.8.8.8/32"]}, "live-b": None})
                time.sleep(4)
                self.assertNotEqual(get(socks_a, "https://8.8.8.8"), "000", "rule change applied")
                self.assertNotEqual(get(socks_b, "https://8.8.8.8"), "000", "user added")
                set_policy({"live-a": a_allow})
                time.sleep(4)
                self.assertEqual(get(socks_b, "https://8.8.8.8"), "000", "user removed")
                self.assertEqual(get(socks_a, "https://8.8.8.8"), "000", "rule removed")
                self.assertEqual(download.communicate()[0], "206 12000000", "download survived every change")
            finally:
                for p in procs:
                    p.kill()


if __name__ == "__main__":
    unittest.main()
