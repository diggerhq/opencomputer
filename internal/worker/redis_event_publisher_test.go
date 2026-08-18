package worker

import "testing"

// The envelope's worker_id is not decoration: events-ingest drops a usage_tick
// whose worker_id disagrees with sandboxes_index.worker_id, so getting this
// wrong loses revenue silently — the ticks are published, acknowledged, and
// then discarded downstream with nothing on our side to show for it.

// A QEMU worker owns everything in its SandboxDBs and configures no resolver.
// It must keep stamping its own id.
func TestWorkerIDForDefaultsToPublisherID(t *testing.T) {
	p := &RedisEventPublisher{workerID: "worker-eastus2-7"}
	if got := p.workerIDFor("sb-abc"); got != "worker-eastus2-7" {
		t.Fatalf("workerIDFor = %q, want the publisher's own id", got)
	}
}

// The MicroVM control plane publishes for sandboxes with differing owners, so
// the resolver — not the publisher's id — decides.
func TestWorkerIDForUsesResolver(t *testing.T) {
	p := &RedisEventPublisher{
		workerID: "microvm-cp",
		workerResolver: func(sandboxID string) (string, bool) {
			return "microvm:" + sandboxID, true
		},
	}
	if got := p.workerIDFor("sb-abc"); got != "microvm:sb-abc" {
		t.Fatalf("workerIDFor = %q, want the resolved owner", got)
	}
}

// A sandbox the resolver cannot place still has to bill. Both the not-ok and
// the empty-string returns fall back rather than emitting a blank owner, since
// dropping the id here is the one outcome nothing downstream would report.
func TestWorkerIDForFallsBackWhenUnresolved(t *testing.T) {
	for name, resolver := range map[string]WorkerIDResolver{
		"not found": func(string) (string, bool) { return "", false },
		"empty id":  func(string) (string, bool) { return "", true },
	} {
		p := &RedisEventPublisher{workerID: "microvm-cp", workerResolver: resolver}
		if got := p.workerIDFor("sb-gone"); got != "microvm-cp" {
			t.Fatalf("%s: workerIDFor = %q, want the fallback id", name, got)
		}
	}
}
