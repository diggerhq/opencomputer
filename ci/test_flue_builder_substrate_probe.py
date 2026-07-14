from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import unittest
from unittest import mock


PROBE_PATH = Path(__file__).with_name("flue-builder-substrate-probe.py")
SPEC = importlib.util.spec_from_file_location("flue_builder_substrate_probe", PROBE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load substrate probe")
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class SubstrateProbeTest(unittest.TestCase):
    def test_static_contract_is_pinned(self) -> None:
        coordinate, manifest = PROBE.static_check()
        self.assertEqual(coordinate["snapshot"]["networkPolicy"], "public")
        self.assertEqual(coordinate["snapshot"]["roles"], ["source", "build"])
        self.assertEqual(manifest["runtimeMemoryMB"], 1024)
        self.assertEqual(
            coordinate["attestation"]["security"],
            {
                "runtimeUser": "sandbox",
                "runtimeUid": 1000,
                "runtimeGid": 1000,
                "supplementaryGroups": [],
                "sudoPolicy": "binary-removed",
                "agentControl": "host-only",
                "toolchainOwner": "root",
                "workspace": "/workspace",
                "workspaceWritable": True,
            },
        )

    def test_root_finalization_precedes_non_root_runtime_proof(self) -> None:
        _, manifest = PROBE.static_check()
        self.assertEqual(
            manifest["steps"][-2],
            {
                "type": "run",
                "args": {
                    "commands": [
                        "sudo -n bash /tmp/opencomputer-flue-builder-install.sh finalize"
                    ]
                },
            },
        )
        self.assertEqual(
            manifest["steps"][-1],
            {
                "type": "run",
                "args": {
                    "commands": [
                        "bash /opt/opencomputer/bin/verify-flue-builder-runtime"
                    ]
                },
            },
        )

    def test_sudo_scan_targets_entrypoints_not_package_directories(self) -> None:
        installer = (PROBE.ROOT / "deploy" / "flue-builder" / "install-snapshot.sh").read_text()
        entrypoint_scan = (
            r"find / -xdev \( -type f -o -type l \) "
            r"\( -name sudo -o -name sudoedit \)"
        )
        self.assertGreaterEqual(installer.count(entrypoint_scan), 2)
        self.assertNotIn("find / -xdev -name sudo", installer)
        self.assertIn("/usr/share/doc/sudo", installer)
        self.assertIn("/usr/lib/*/sudo", installer)

    def test_private_canary_requires_literal_private_or_cgnat_address(self) -> None:
        for value in (
            "http://10.1.2.3/probe",
            "https://172.16.0.1:8443/probe",
            "http://192.168.1.1/probe",
            "http://100.64.1.2/probe",
        ):
            self.assertEqual(PROBE.validate_private_canary(value), value)

        for value in (
            "https://example.com/probe",
            "https://8.8.8.8/probe",
            "http://169.254.169.254/probe",
            "http://user:password@10.1.2.3/probe",
            "http://10.1.2.3/probe?token=nope",
        ):
            with self.subTest(value=value), self.assertRaises(PROBE.ProbeError):
                PROBE.validate_private_canary(value)

    def test_production_and_http_urls_require_separate_guards(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(PROBE.ProbeError):
                PROBE.safe_api_url("https://app.opencomputer.dev")
            with self.assertRaises(PROBE.ProbeError):
                PROBE.safe_api_url("http://127.0.0.1:8080")

        with mock.patch.dict(
            os.environ,
            {
                "AGENT_BUILD_PROBE_ALLOW_PRODUCTION": "1",
                "AGENT_BUILD_PROBE_ALLOW_HTTP": "1",
            },
            clear=True,
        ):
            self.assertEqual(
                PROBE.safe_api_url("https://app.opencomputer.dev"),
                "https://app.opencomputer.dev/api",
            )
            self.assertEqual(
                PROBE.safe_api_url("http://127.0.0.1:8080"),
                "http://127.0.0.1:8080/api",
            )

    def test_only_curl_connection_failure_counts_as_transport_block(self) -> None:
        for exit_code in (7, 28):
            PROBE.LiveProbe.expect_transport_block("target", {"exitCode": exit_code})
        for exit_code in (0, 22, 35, 127):
            with self.subTest(exit_code=exit_code), self.assertRaises(PROBE.ProbeError):
                PROBE.LiveProbe.expect_transport_block("target", {"exitCode": exit_code})

    def test_guest_agent_isolation_requires_adversarial_probe_success(self) -> None:
        live = PROBE.LiveProbe.__new__(PROBE.LiveProbe)
        live.exec = mock.Mock(
            return_value={"exitCode": 0, "stdout": '{"checked":["vsock:1:1024"],"failures":[]}'}
        )
        live.prove_guest_agent_isolation("sb-test")
        command = live.exec.call_args.args
        self.assertEqual(command[:2], ("sb-test", "/usr/bin/python3"))
        self.assertIn("HTTP2_PREFACE", command[2][1])

        live.exec.return_value = {
            "exitCode": 42,
            "stdout": '{"checked":["vsock:1:1024"],"failures":["vsock:1:1024"]}',
        }
        with self.assertRaises(PROBE.ProbeError):
            live.prove_guest_agent_isolation("sb-test")

        live.exec.return_value = {"exitCode": 0, "stdout": '{"checked":[],"failures":[]}'}
        with self.assertRaises(PROBE.ProbeError):
            live.prove_guest_agent_isolation("sb-test")

    def test_create_body_is_allowlisted_and_final_topology_is_explicit(self) -> None:
        live = PROBE.LiveProbe.__new__(PROBE.LiveProbe)
        live.snapshot_name = "snapshot-coordinate"
        live.checkpoint_id = "00000000-0000-0000-0000-000000000001"
        live.sandboxes = []
        calls: list[tuple[str, str, object]] = []

        def fake_call(
            method: str,
            path: str,
            body: object = None,
            allowed_statuses: set[int] | None = None,
            timeout: float = 60,
        ) -> tuple[int, object]:
            calls.append((method, path, body))
            return 201, {
                "sandboxID": "sb-test",
                "fromCheckpointId": live.checkpoint_id,
                "status": "running",
            }

        live.call = fake_call
        live.create_sandbox(restricted=True)
        self.assertEqual(
            calls,
            [
                (
                    "POST",
                    "/sandboxes",
                    {
                        "snapshot": "snapshot-coordinate",
                        "timeout": 600,
                        "networkPolicy": "public",
                    },
                )
            ],
        )
        self.assertNotIn("envs", calls[0][2])
        self.assertNotIn("secretStore", calls[0][2])


if __name__ == "__main__":
    unittest.main()
