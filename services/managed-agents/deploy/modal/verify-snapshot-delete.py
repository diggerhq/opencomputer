"""Checks that deleting a superseded snapshot never breaks the latest one.

The shim keeps one snapshot per session forever and may delete the one a
newer snapshot replaced (SNAPSHOT_DELETE_SUPERSEDED=1). A session's next
snapshot is taken from a sandbox that was itself restored from the previous
one, so this must hold before the flag is turned on:

    restore from A, snapshot B, delete A  ->  B still restores, with A's files

Runs the same calls the shim makes (runtime="vm", Image.from_id), on a
plain base image in its own app, and cleans up after itself.
Usage:
    modal token set --token-id ... --token-secret ...
    python deploy/modal/verify-snapshot-delete.py
Exit status 0 means the flag is safe to enable.
"""
import os
import sys

import modal
import modal.experimental

APP_NAME = os.environ.get("MODAL_APP_NAME", "blue-snapshot-delete-check")


def run(sb: modal.Sandbox, script: str) -> str:
    p = sb.exec("sh", "-c", script)
    out = p.stdout.read()
    if p.wait() != 0:
        raise RuntimeError(f"{script!r} failed: {p.stderr.read()}")
    return out


def create(app: modal.App, image: modal.Image) -> modal.Sandbox:
    return modal.Sandbox.create(app=app, image=image, runtime="vm", timeout=600)


def main() -> int:
    app = modal.App.lookup(APP_NAME, create_if_missing=True)
    base = modal.Image.debian_slim()
    created: list[str] = []
    try:
        sb = create(app, base)
        run(sb, "echo first > /root/a")
        a = sb.snapshot_filesystem()
        created.append(a.object_id)
        sb.terminate()

        sb = create(app, modal.Image.from_id(a.object_id))
        run(sb, "echo second > /root/b")
        b = sb.snapshot_filesystem()
        created.append(b.object_id)
        sb.terminate()

        modal.experimental.image_delete(a.object_id)
        created.remove(a.object_id)

        sb = create(app, modal.Image.from_id(b.object_id))
        contents = run(sb, "cat /root/a /root/b")
        sb.terminate()
        if contents.split() != ["first", "second"]:
            print(f"FAIL: restored B after deleting A, files read {contents!r}")
            return 1
        print(f"PASS: B ({b.object_id}) restores with A's and its own files after A was deleted")
        return 0
    except Exception as e:
        print(f"FAIL: {e}")
        return 1
    finally:
        for image_id in created:
            try:
                modal.experimental.image_delete(image_id)
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
