package worker

import (
	"testing"

	"google.golang.org/protobuf/proto"
)

func TestCreateCheckpointRequestKindRoundTrip(t *testing.T) {
	msg := &CreateCheckpointRequest{
		SandboxId:    "sb-test",
		CheckpointId: "cp-test",
		Kind:         "disk_only",
	}
	data, err := proto.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out CreateCheckpointRequest
	if err := proto.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Kind != "disk_only" {
		t.Fatalf("kind did not round trip: got %q", out.Kind)
	}
}
