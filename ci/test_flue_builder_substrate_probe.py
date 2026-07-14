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
        self.assertEqual(manifest["runtimeMemoryMB"], 1024)

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
