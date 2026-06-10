package compute

import (
	"strings"
	"testing"
)

func TestEC2UserDataStaticOCFS2Slots(t *testing.T) {
	p := &EC2Pool{cfg: EC2PoolConfig{
		Region:                    "us-east-2",
		CellID:                    "aws-us-east-2-burst-prod",
		SharedSandboxDataVolumeID: "vol-123",
		OCFS2ClusterName:          "opensandbox",
		OCFS2MaxNodes:             4,
	}}

	userData := p.buildUserData(MachineOpts{}, ocfs2Assignment{
		Enabled: true,
		Slot:    1,
		IP:      "10.60.1.11",
		NodeIPs: []string{"10.60.1.10", "10.60.1.11", "10.60.1.12", "10.60.1.13"},
	})

	for _, want := range []string{
		`OCFS2_NODE_SLOT=1`,
		`OCFS2_NODE_IP="10.60.1.11"`,
		`OCFS2_NODE_NAMES+=("ip-10-60-1-10")`,
		`OCFS2_NODE_NAMES+=("ip-10-60-1-13")`,
		`OCFS2_NODE_IPS+=("10.60.1.12")`,
		`node_count = ${#OCFS2_NODE_IPS[@]}`,
		`mkfs.ocfs2 -F -N "$OCFS2_MAX_NODES"`,
	} {
		if !strings.Contains(userData, want) {
			t.Fatalf("user-data missing %q", want)
		}
	}

	if strings.Contains(userData, "discovering OCFS2 peer nodes") {
		t.Fatal("static OCFS2 user-data should not discover live EC2 peers")
	}
}

func TestAWSPrivateDNSShortName(t *testing.T) {
	got := awsPrivateDNSShortName("10.60.1.122")
	if got != "ip-10-60-1-122" {
		t.Fatalf("awsPrivateDNSShortName() = %q", got)
	}
}
