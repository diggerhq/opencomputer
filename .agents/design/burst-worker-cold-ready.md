# Burst Worker Cold-Ready Startup Plan

## Context

The burst worker launch test on June 10, 2026 showed two different timing
segments:

- EC2 instance creation to worker service start was roughly 90 seconds.
- Worker service start to control-plane registration was much longer because
  startup blocked on `PrepareGoldenSnapshot`.

The important observation is that the worker can be useful for cold boots
before the golden snapshot is ready. The current startup path does not expose
that intermediate state because the worker prepares the golden snapshot before
starting its servers and heartbeat.

## Goal

Make a newly launched burst worker register as soon as it is cold-boot capable,
while preparing the golden snapshot in the background.

Target behavior:

- Worker becomes schedulable for cold boots as soon as networking, env, shared
  mounts, gRPC, HTTP, and Redis heartbeat are ready.
- Golden snapshot preparation continues asynchronously.
- Once the golden snapshot is ready, the worker heartbeat advertises the golden
  version and the control plane can prefer it for fast creates.

This does not remove EC2 launch latency. It removes golden snapshot creation
from the critical path for worker registration.

## Proposed Changes

1. Move golden snapshot preparation out of the blocking worker startup path.

   Today `cmd/worker/main.go` calls `PrepareGoldenSnapshot()` before starting
   metadata, HTTP/gRPC, and Redis heartbeat. Move this after server startup and
   heartbeat setup, running in a background goroutine.

2. Register the worker as cold-ready first.

   Heartbeat should be published with no `golden_version` until the snapshot is
   ready. The control plane already treats empty `golden_version` as "no golden
   snapshot available"; keep that meaning.

3. Update heartbeat when golden prep completes.

   After background `PrepareGoldenSnapshot()` succeeds, call
   `hb.SetGoldenVersion(qemuMgr.GoldenVersion())`. The next heartbeat should
   update the registry.

4. Add explicit logs for readiness phases.

   Suggested log points:

   - `worker cold-ready: starting heartbeat before golden snapshot`
   - `worker golden snapshot preparation started in background`
   - `worker golden-ready: version=<hash>`
   - `worker golden preparation failed: <err>; continuing cold-ready`

5. Fix AMI/systemd ordering for burst workers.

   The burst AMI currently enables `opensandbox-worker.service`, so systemd can
   start it before user-data writes `/etc/opensandbox/worker.env`. That caused
   repeated `Failed to load environment files` messages during boot.

   Change the burst Packer file to install the worker unit but leave it
   disabled. User-data should start the worker exactly once after:

   - instance identity is known
   - shared volumes are attached/mounted
   - `/etc/opensandbox/worker.env` has been written and patched

6. Keep user-data minimal.

   User-data should only do runtime-specific work:

   - fetch instance identity
   - attach/mount shared volumes
   - write env
   - start worker

   Dependency installation, binaries, OCFS2 tools, AWS CLI, QEMU, kernel
   modules, and rootfs assets should stay baked into the AMI.

## Non-Goals

- Do not change Spot instance type fallback strategy yet.
- Do not try to guarantee sub-10-second readiness from a brand-new EC2 launch.
- Do not implement downloaded/prebuilt QEMU memory snapshots in this pass.
- Do not change public API behavior.

## Expected Impact

Based on the June 10 test:

- Current EC2-created-to-registered time was about 6 minutes 24 seconds.
- Worker service started about 91 seconds after EC2 creation.
- Moving golden prep to the background could make cold-ready registration close
  to that worker-service-start time, likely around 90-100 seconds from EC2
  creation before further AMI cleanup.

With AMI/systemd cleanup, a realistic next target is roughly 45-70 seconds from
EC2 creation to cold-ready in favorable cases.

## Risks

- Cold-ready workers may serve slower first sandboxes until golden prep
  completes.
- Some scheduling paths may implicitly assume a non-empty `golden_version`.
  Those paths need review before allowing all workloads onto cold-ready workers.
- Migration/checkpoint paths that require a known source golden version should
  continue to require it.

## Validation Plan

1. Build and deploy a worker with background golden prep.
2. Launch a fresh burst worker and capture timestamps:
   - scaler launch decision
   - EC2 instance created
   - user-data start
   - worker service start
   - first Redis heartbeat / CP registration
   - golden snapshot ready
3. Confirm the CP sees the worker before golden snapshot readiness.
4. Create a sandbox on the cold-ready worker and verify it succeeds via cold
   boot.
5. Wait for golden-ready heartbeat and verify subsequent creates use the golden
   path.
6. Terminate the extra worker after the test to avoid unnecessary cost.
