from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import unittest
from unittest import mock


PROBE_PATH = Path(__file__).with_name("flue-builder-substrate-probe.py")
SPEC = importlib.util.spec_from_file_location("flue_builder_substrate_probe", PROBE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load sandbox probe")
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class SandboxProbeTest(unittest.TestCase):
    def test_static_contract_uses_an_ordinary_sandbox(self) -> None:
        coordinate, manifest = PROBE.static_check()

        self.assertEqual(
            set(coordinate["snapshot"]),
            {"name", "builderMemoryMB", "runtimeMemoryMB"},
        )
        self.assertEqual(manifest["runtimeMemoryMB"], 1024)
        self.assertEqual(PROBE.STARTER_REF, "5c51d7edbbf2472fbe48386c4f9b192279330c9b")

    def test_runtime_attestation_compare_uses_a_writable_temp_file(self) -> None:
        installer = (
            PROBE.ROOT / "deploy" / "flue-builder" / "install-snapshot.sh"
        ).read_text()
        verify = installer.split("verify() {", 1)[1].split("\n}", 1)[0]

        self.assertIn("expected_attestation=\"$(mktemp)\"", verify)
        self.assertNotIn("/dev/stdout", verify)

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

    def test_create_body_is_the_standard_snapshot_create_shape(self) -> None:
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
        self.assertEqual(live.create_sandbox(), "sb-test")
        self.assertEqual(
            calls,
            [
                (
                    "POST",
                    "/sandboxes",
                    {
                        "snapshot": "snapshot-coordinate",
                        "timeout": 600,
                    },
                )
            ],
        )
        body = calls[0][2]
        self.assertIsInstance(body, dict)
        self.assertNotIn("envs", body)
        self.assertNotIn("secretStore", body)

    def test_create_rejects_a_different_checkpoint(self) -> None:
        live = PROBE.LiveProbe.__new__(PROBE.LiveProbe)
        live.snapshot_name = "snapshot-coordinate"
        live.checkpoint_id = "00000000-0000-0000-0000-000000000001"
        live.sandboxes = []
        live.call = lambda *_args, **_kwargs: (
            201,
            {
                "sandboxID": "sb-test",
                "fromCheckpointId": "00000000-0000-0000-0000-000000000002",
            },
        )

        with self.assertRaisesRegex(PROBE.ProbeError, "pinned checkpoint"):
            live.create_sandbox()
        self.assertEqual(live.sandboxes, ["sb-test"])

    def test_exec_uses_the_public_async_result_contract(self) -> None:
        live = PROBE.LiveProbe.__new__(PROBE.LiveProbe)
        calls: list[tuple[str, str, object]] = []
        responses = iter(
            [
                (202, {"execId": "exec-test", "running": True}),
                (200, {"running": True}),
                (200, {"running": False, "exitCode": 0, "stdout": "ok", "stderr": ""}),
            ]
        )

        def fake_call(
            method: str,
            path: str,
            body: object = None,
            allowed_statuses: set[int] | None = None,
            timeout: float = 60,
        ) -> tuple[int, object]:
            calls.append((method, path, body))
            return next(responses)

        live.call = fake_call
        with mock.patch.object(PROBE.time, "sleep"):
            result = live.exec("sb-test", "/bin/echo", ["ok"], {"CI": "1"}, timeout=5)

        self.assertEqual(result["stdout"], "ok")
        self.assertEqual(calls[0], (
            "POST",
            "/sandboxes/sb-test/exec/run-async",
            {"cmd": "/bin/echo", "args": ["ok"], "timeout": 5, "envs": {"CI": "1"}},
        ))
        self.assertEqual(
            [call[:2] for call in calls[1:]],
            [
                ("GET", "/sandboxes/sb-test/exec/exec-test/result"),
                ("GET", "/sandboxes/sb-test/exec/exec-test/result"),
            ],
        )

    def test_destroy_attempts_every_created_sandbox(self) -> None:
        live = PROBE.LiveProbe.__new__(PROBE.LiveProbe)
        live.sandboxes = ["sb-one", "sb-two"]
        calls: list[str] = []

        def fake_call(
            _method: str,
            path: str,
            _body: object = None,
            allowed_statuses: set[int] | None = None,
            timeout: float = 60,
        ) -> tuple[int, object]:
            calls.append(path)
            return 204, None

        live.call = fake_call
        self.assertEqual(live.destroy_all(), [])
        self.assertEqual(calls, ["/sandboxes/sb-two", "/sandboxes/sb-one"])
        self.assertEqual(live.sandboxes, [])


if __name__ == "__main__":
    unittest.main()
