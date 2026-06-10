package compute

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

// ec2QuotaCodes are the AWS EC2 error codes that indicate a vCPU quota,
// per-account instance limit, or AZ-level capacity exhaustion. All of these
// are recoverable by retrying with a different instance type, so the
// autoscaler treats them as the ErrQuotaExceeded class.
var ec2QuotaCodes = []string{
	"VcpuLimitExceeded",
	"InstanceLimitExceeded",
	"InsufficientInstanceCapacity",
	"MaxSpotInstanceCountExceeded",
	"Unsupported", // returned when a region/AZ doesn't offer the requested type
}

func isEC2QuotaErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	for _, code := range ec2QuotaCodes {
		if strings.Contains(msg, code) {
			return true
		}
	}
	return false
}

func wrapEC2CreateErr(err error, format string, args ...any) error {
	wrapped := fmt.Errorf(format, args...)
	if isEC2QuotaErr(err) {
		return errors.Join(ErrQuotaExceeded, wrapped)
	}
	return wrapped
}

func supportsEC2NestedVirtualization(instanceType string) bool {
	family, _, _ := strings.Cut(strings.ToLower(instanceType), ".")
	switch family {
	case "c8i", "m8i", "r8i":
		return true
	default:
		return false
	}
}

const (
	// AWS tag keys (kept consistent with the Azure pool's azure-prefixed tags).
	awsTagRole         = "opensandbox:role"
	awsTagCell         = "opensandbox:cell"
	awsTagInstanceType = "opensandbox:instance-type"
	awsTagDraining     = "opensandbox:draining"
	awsTagOCFS2Slot    = "opensandbox:ocfs2-slot"
	awsTagOCFS2IP      = "opensandbox:ocfs2-ip"
	awsTagWorker       = "worker"
)

// EC2PoolConfig configures the EC2 compute pool.
type EC2PoolConfig struct {
	Region                    string
	AccessKeyID               string // empty = use default credential chain (IAM role preferred)
	SecretAccessKey           string
	AMI                       string // static AMI ID; empty if SSMParameterName is set
	InstanceType              string // e.g. "c7gd.metal", "r7gd.xlarge", "m7i.large"
	SubnetID                  string
	SecurityGroupID           string
	KeyName                   string // optional SSH key pair (debug use only)
	IAMInstanceProfile        string // attached to instances; gives them Secrets Manager + S3 read
	SecretsARN                string // Secrets Manager ARN; passed to worker via WorkerSpec.SecretsRef
	SSMParameterName          string // SSM parameter for dynamic AMI ID (e.g. /opensandbox/dev/worker-ami-id)
	MarketType                string // empty/on-demand or spot
	CellID                    string
	SharedSandboxDataVolumeID string // optional io2 Multi-Attach volume mounted at /data/sandboxes via OCFS2
	SharedGoldensVolumeID     string // optional io2 Multi-Attach volume for golden image cache
	OCFS2ClusterName          string
	OCFS2ExpectedNodes        int
	OCFS2MaxNodes             int
	OCFS2NodeIPs              []string // fixed private IPs, one per OCFS2 node slot
}

type ocfs2Assignment struct {
	Enabled bool
	Slot    int
	IP      string
	NodeIPs []string
}

// EC2Pool implements compute.Pool using AWS EC2 instances.
//
// Worker bring-up: the CP injects a WorkerSpec via SetWorkerSpec at startup.
// CreateMachine combines the spec with EC2-specific cloud-init (NVMe instance
// store mounting, IAM-role secret fetch, AMI-baked image layout) to produce
// instance user-data.
//
// Mirrors AzurePool conventions where applicable so cells in either cloud
// behave identically from the CP's perspective.
type EC2Pool struct {
	client *ec2.Client
	awsCfg aws.Config
	mu     sync.RWMutex // protects cfg.AMI + spec
	cfg    EC2PoolConfig
	spec   WorkerSpec // injected via SetWorkerSpec; copied into worker env on every CreateMachine
}

// SetWorkerSpec injects the cloud-neutral worker config. Idempotent.
// Implements compute.WorkerSpecHolder.
func (p *EC2Pool) SetWorkerSpec(spec WorkerSpec) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// EC2 worker fetches secrets via Secrets Manager + IAM, so propagate the ARN.
	if p.cfg.SecretsARN != "" && spec.SecretsRef == "" {
		spec.SecretsRef = p.cfg.SecretsARN
	}
	p.spec = spec
}

// NewEC2Pool creates an EC2 compute pool.
// If AccessKeyID is empty, uses the default AWS credential chain (IAM
// instance profile preferred, then env vars, then ~/.aws/credentials).
func NewEC2Pool(cfg EC2PoolConfig) (*EC2Pool, error) {
	var awsCfgVal aws.Config

	if cfg.AccessKeyID != "" {
		awsCfgVal = aws.Config{
			Region: cfg.Region,
			Credentials: credentials.NewStaticCredentialsProvider(
				cfg.AccessKeyID,
				cfg.SecretAccessKey,
				"",
			),
		}
	} else {
		var err error
		awsCfgVal, err = awsconfig.LoadDefaultConfig(context.Background(),
			awsconfig.WithRegion(cfg.Region),
		)
		if err != nil {
			return nil, fmt.Errorf("ec2: failed to load AWS config: %w", err)
		}
	}

	return &EC2Pool{
		client: ec2.NewFromConfig(awsCfgVal),
		awsCfg: awsCfgVal,
		cfg:    cfg,
	}, nil
}

func (p *EC2Pool) CreateMachine(ctx context.Context, opts MachineOpts) (*Machine, error) {
	instanceType := p.cfg.InstanceType
	if opts.Size != "" {
		instanceType = opts.Size
	}

	p.mu.RLock()
	ami := p.cfg.AMI
	p.mu.RUnlock()
	if opts.Image != "" {
		ami = opts.Image
	}
	if ami == "" {
		return nil, fmt.Errorf("ec2: no AMI set (configure AMI or SSMParameterName)")
	}

	ocfs2, err := p.allocateOCFS2Slot(ctx)
	if err != nil {
		return nil, err
	}

	userData := p.buildUserData(opts, ocfs2)
	machineName := fmt.Sprintf("osb-worker-%s", randomSuffix())
	instanceTags := []ec2types.Tag{
		{Key: aws.String("Name"), Value: aws.String(machineName)},
		{Key: aws.String("Role"), Value: aws.String("worker")},
		{Key: aws.String(awsTagRole), Value: aws.String(awsTagWorker)},
		{Key: aws.String(awsTagInstanceType), Value: aws.String(instanceType)},
	}
	if ocfs2.Enabled {
		instanceTags = append(instanceTags,
			ec2types.Tag{Key: aws.String(awsTagOCFS2Slot), Value: aws.String(strconv.Itoa(ocfs2.Slot))},
			ec2types.Tag{Key: aws.String(awsTagOCFS2IP), Value: aws.String(ocfs2.IP)},
		)
	}
	volumeTags := []ec2types.Tag{
		{Key: aws.String(awsTagRole), Value: aws.String(awsTagWorker)},
	}
	if p.cfg.CellID != "" {
		instanceTags = append(instanceTags,
			ec2types.Tag{Key: aws.String("Cell"), Value: aws.String(p.cfg.CellID)},
			ec2types.Tag{Key: aws.String(awsTagCell), Value: aws.String(p.cfg.CellID)},
		)
		volumeTags = append(volumeTags,
			ec2types.Tag{Key: aws.String("Cell"), Value: aws.String(p.cfg.CellID)},
			ec2types.Tag{Key: aws.String(awsTagCell), Value: aws.String(p.cfg.CellID)},
		)
	}

	input := &ec2.RunInstancesInput{
		ImageId:      aws.String(ami),
		InstanceType: ec2types.InstanceType(instanceType),
		MinCount:     aws.Int32(1),
		MaxCount:     aws.Int32(1),
		UserData:     aws.String(base64.StdEncoding.EncodeToString([]byte(userData))),
		TagSpecifications: []ec2types.TagSpecification{
			{
				ResourceType: ec2types.ResourceTypeInstance,
				Tags:         instanceTags,
			},
			{
				ResourceType: ec2types.ResourceTypeVolume,
				Tags:         volumeTags,
			},
		},
	}
	if strings.EqualFold(p.cfg.MarketType, "spot") {
		input.InstanceMarketOptions = &ec2types.InstanceMarketOptionsRequest{
			MarketType: ec2types.MarketTypeSpot,
			SpotOptions: &ec2types.SpotMarketOptions{
				InstanceInterruptionBehavior: ec2types.InstanceInterruptionBehaviorTerminate,
				SpotInstanceType:             ec2types.SpotInstanceTypeOneTime,
			},
		}
	}

	if supportsEC2NestedVirtualization(instanceType) {
		input.CpuOptions = &ec2types.CpuOptionsRequest{
			NestedVirtualization: ec2types.NestedVirtualizationSpecificationEnabled,
		}
	}

	if p.cfg.SubnetID != "" {
		input.SubnetId = aws.String(p.cfg.SubnetID)
	}
	if p.cfg.SecurityGroupID != "" {
		input.SecurityGroupIds = []string{p.cfg.SecurityGroupID}
	}
	if ocfs2.Enabled {
		input.PrivateIpAddress = aws.String(ocfs2.IP)
	}
	if p.cfg.KeyName != "" {
		input.KeyName = aws.String(p.cfg.KeyName)
	}
	if p.cfg.IAMInstanceProfile != "" {
		input.IamInstanceProfile = &ec2types.IamInstanceProfileSpecification{
			Name: aws.String(p.cfg.IAMInstanceProfile),
		}
	}

	result, err := p.client.RunInstances(ctx, input)
	if err != nil {
		return nil, wrapEC2CreateErr(err, "ec2: RunInstances failed: %w", err)
	}
	if len(result.Instances) == 0 {
		return nil, fmt.Errorf("ec2: no instances returned")
	}
	inst := result.Instances[0]
	return p.instanceToMachine(&inst), nil
}

func (p *EC2Pool) DestroyMachine(ctx context.Context, machineID string) error {
	_, err := p.client.TerminateInstances(ctx, &ec2.TerminateInstancesInput{
		InstanceIds: []string{machineID},
	})
	if err != nil {
		return fmt.Errorf("ec2: TerminateInstances %s: %w", machineID, err)
	}
	return nil
}

func (p *EC2Pool) StartMachine(ctx context.Context, machineID string) error {
	_, err := p.client.StartInstances(ctx, &ec2.StartInstancesInput{
		InstanceIds: []string{machineID},
	})
	if err != nil {
		return fmt.Errorf("ec2: StartInstances %s: %w", machineID, err)
	}
	return nil
}

func (p *EC2Pool) StopMachine(ctx context.Context, machineID string) error {
	_, err := p.client.StopInstances(ctx, &ec2.StopInstancesInput{
		InstanceIds: []string{machineID},
	})
	if err != nil {
		return fmt.Errorf("ec2: StopInstances %s: %w", machineID, err)
	}
	return nil
}

func (p *EC2Pool) ListMachines(ctx context.Context) ([]*Machine, error) {
	input := &ec2.DescribeInstancesInput{
		Filters: []ec2types.Filter{
			{Name: aws.String("tag:" + awsTagRole), Values: []string{awsTagWorker}},
			{Name: aws.String("instance-state-name"), Values: []string{"pending", "running", "stopping", "stopped"}},
		},
	}
	result, err := p.client.DescribeInstances(ctx, input)
	if err != nil {
		return nil, fmt.Errorf("ec2: DescribeInstances: %w", err)
	}
	var machines []*Machine
	for _, res := range result.Reservations {
		for _, inst := range res.Instances {
			machines = append(machines, p.instanceToMachine(&inst))
		}
	}
	return machines, nil
}

func (p *EC2Pool) HealthCheck(ctx context.Context, machineID string) error {
	result, err := p.client.DescribeInstanceStatus(ctx, &ec2.DescribeInstanceStatusInput{
		InstanceIds: []string{machineID},
	})
	if err != nil {
		return fmt.Errorf("ec2: DescribeInstanceStatus %s: %w", machineID, err)
	}
	if len(result.InstanceStatuses) == 0 {
		return fmt.Errorf("ec2: instance %s not found or not running", machineID)
	}
	st := result.InstanceStatuses[0]
	if st.InstanceStatus.Status != ec2types.SummaryStatusOk {
		return fmt.Errorf("ec2: instance %s status is %s", machineID, st.InstanceStatus.Status)
	}
	return nil
}

func (p *EC2Pool) SupportedRegions(_ context.Context) ([]string, error) {
	return []string{p.cfg.Region}, nil
}

func (p *EC2Pool) DrainMachine(ctx context.Context, machineID string) error {
	_, err := p.client.CreateTags(ctx, &ec2.CreateTagsInput{
		Resources: []string{machineID},
		Tags:      []ec2types.Tag{{Key: aws.String(awsTagDraining), Value: aws.String("true")}},
	})
	if err != nil {
		return fmt.Errorf("ec2: tag %s draining: %w", machineID, err)
	}
	return nil
}

func (p *EC2Pool) allocateOCFS2Slot(ctx context.Context) (ocfs2Assignment, error) {
	if p.cfg.SharedSandboxDataVolumeID == "" || len(p.cfg.OCFS2NodeIPs) == 0 {
		return ocfs2Assignment{}, nil
	}

	used := make(map[int]bool, len(p.cfg.OCFS2NodeIPs))
	ipToSlot := make(map[string]int, len(p.cfg.OCFS2NodeIPs))
	for i, ip := range p.cfg.OCFS2NodeIPs {
		ip = strings.TrimSpace(ip)
		if ip == "" {
			return ocfs2Assignment{}, fmt.Errorf("ec2: OCFS2 node IP slot %d is empty", i)
		}
		ipToSlot[ip] = i
	}

	filters := []ec2types.Filter{
		{Name: aws.String("tag:" + awsTagRole), Values: []string{awsTagWorker}},
		{Name: aws.String("instance-state-name"), Values: []string{"pending", "running", "stopping", "stopped"}},
	}
	if p.cfg.CellID != "" {
		filters = append(filters, ec2types.Filter{Name: aws.String("tag:" + awsTagCell), Values: []string{p.cfg.CellID}})
	}

	result, err := p.client.DescribeInstances(ctx, &ec2.DescribeInstancesInput{Filters: filters})
	if err != nil {
		return ocfs2Assignment{}, fmt.Errorf("ec2: describe workers for OCFS2 slot allocation: %w", err)
	}
	for _, res := range result.Reservations {
		for _, inst := range res.Instances {
			if inst.PrivateIpAddress != nil {
				if slot, ok := ipToSlot[aws.ToString(inst.PrivateIpAddress)]; ok {
					used[slot] = true
				}
			}
			for _, tag := range inst.Tags {
				if aws.ToString(tag.Key) != awsTagOCFS2Slot {
					continue
				}
				slot, convErr := strconv.Atoi(aws.ToString(tag.Value))
				if convErr == nil && slot >= 0 && slot < len(p.cfg.OCFS2NodeIPs) {
					used[slot] = true
				}
			}
		}
	}

	for slot, ip := range p.cfg.OCFS2NodeIPs {
		if used[slot] {
			continue
		}
		return ocfs2Assignment{
			Enabled: true,
			Slot:    slot,
			IP:      strings.TrimSpace(ip),
			NodeIPs: append([]string(nil), p.cfg.OCFS2NodeIPs...),
		}, nil
	}

	return ocfs2Assignment{}, fmt.Errorf("ec2: no free OCFS2 node slots available (%d configured)", len(p.cfg.OCFS2NodeIPs))
}

// CleanupOrphanedResources reclaims ENIs and EBS volumes left by failed
// VM creates. Mirrors the AzurePool's NIC/disk cleanup.
//
// Satisfies the controlplane.OrphanCleaner interface.
func (p *EC2Pool) CleanupOrphanedResources(ctx context.Context) (int, error) {
	freed := 0

	// Orphaned ENIs: tagged osb-worker but unattached for >5 min.
	nicResp, err := p.client.DescribeNetworkInterfaces(ctx, &ec2.DescribeNetworkInterfacesInput{
		Filters: []ec2types.Filter{
			{Name: aws.String("tag:" + awsTagRole), Values: []string{awsTagWorker}},
			{Name: aws.String("status"), Values: []string{"available"}},
		},
	})
	if err == nil {
		for _, n := range nicResp.NetworkInterfaces {
			if _, dErr := p.client.DeleteNetworkInterface(ctx, &ec2.DeleteNetworkInterfaceInput{
				NetworkInterfaceId: n.NetworkInterfaceId,
			}); dErr == nil {
				freed++
			} else {
				log.Printf("ec2: orphan ENI cleanup %s: %v", aws.ToString(n.NetworkInterfaceId), dErr)
			}
		}
	}

	// Orphaned EBS volumes: tagged osb-worker, status=available.
	volResp, err := p.client.DescribeVolumes(ctx, &ec2.DescribeVolumesInput{
		Filters: []ec2types.Filter{
			{Name: aws.String("tag:" + awsTagRole), Values: []string{awsTagWorker}},
			{Name: aws.String("status"), Values: []string{"available"}},
		},
	})
	if err == nil {
		for _, v := range volResp.Volumes {
			if _, dErr := p.client.DeleteVolume(ctx, &ec2.DeleteVolumeInput{
				VolumeId: v.VolumeId,
			}); dErr == nil {
				freed++
			} else {
				log.Printf("ec2: orphan volume cleanup %s: %v", aws.ToString(v.VolumeId), dErr)
			}
		}
	}

	return freed, nil
}

// RefreshAMI checks SSM Parameter Store for a new AMI ID and updates the pool config.
// Returns the current AMI ID and the version string (if a sibling parameter exists).
// If SSMParameterName is not configured, returns the static AMI with no error.
//
// Satisfies the controlplane.AMIRefresher interface.
func (p *EC2Pool) RefreshAMI(ctx context.Context) (amiID string, version string, err error) {
	if p.cfg.SSMParameterName == "" {
		p.mu.RLock()
		defer p.mu.RUnlock()
		return p.cfg.AMI, "", nil
	}

	ssmClient := ssm.NewFromConfig(p.awsCfg)

	result, err := ssmClient.GetParameter(ctx, &ssm.GetParameterInput{
		Name: aws.String(p.cfg.SSMParameterName),
	})
	if err != nil {
		return "", "", fmt.Errorf("ec2: SSM GetParameter %s: %w", p.cfg.SSMParameterName, err)
	}
	newAMI := aws.ToString(result.Parameter.Value)
	if newAMI == "" {
		return "", "", fmt.Errorf("ec2: SSM parameter %s is empty", p.cfg.SSMParameterName)
	}

	// Sibling version param convention: replace last segment with worker-ami-version
	versionParam := p.cfg.SSMParameterName[:strings.LastIndex(p.cfg.SSMParameterName, "/")+1] + "worker-ami-version"
	if vResult, vErr := ssmClient.GetParameter(ctx, &ssm.GetParameterInput{
		Name: aws.String(versionParam),
	}); vErr == nil {
		version = aws.ToString(vResult.Parameter.Value)
	}

	p.mu.Lock()
	if newAMI != p.cfg.AMI {
		log.Printf("ec2: AMI updated via SSM: %s -> %s (version=%s)", p.cfg.AMI, newAMI, version)
		p.cfg.AMI = newAMI
	}
	p.mu.Unlock()

	return newAMI, version, nil
}

func (p *EC2Pool) instanceToMachine(inst *ec2types.Instance) *Machine {
	id := aws.ToString(inst.InstanceId)
	status := "creating"
	if inst.State != nil {
		switch inst.State.Name {
		case ec2types.InstanceStateNameRunning:
			status = "running"
		case ec2types.InstanceStateNameStopped:
			status = "stopped"
		case ec2types.InstanceStateNamePending:
			status = "creating"
		case ec2types.InstanceStateNameTerminated, ec2types.InstanceStateNameShuttingDown:
			status = "stopped"
		}
	}

	addr := ""
	if inst.PrivateIpAddress != nil {
		addr = fmt.Sprintf("%s:9090", aws.ToString(inst.PrivateIpAddress))
	}
	httpAddr := ""
	if inst.PublicIpAddress != nil {
		httpAddr = fmt.Sprintf("http://%s:8080", aws.ToString(inst.PublicIpAddress))
	}
	region := ""
	if inst.Placement != nil {
		region = aws.ToString(inst.Placement.AvailabilityZone)
	}

	return &Machine{
		ID:       id,
		Addr:     addr,
		HTTPAddr: httpAddr,
		Region:   region,
		Status:   status,
	}
}

// buildUserData returns the EC2 instance user-data script. Combines the
// CP-supplied WorkerSpec with EC2-specific cloud-init (NVMe instance-store
// mount, AMI-baked rootfs copy, machine-id stamping).
func (p *EC2Pool) buildUserData(opts MachineOpts, ocfs2 ocfs2Assignment) string {
	_ = opts // opts.Region/Size honored at instance launch; cloud-init is cell-uniform
	var sb strings.Builder
	sb.WriteString("#!/bin/bash\nset -euo pipefail\n\n")
	sb.WriteString("oc_boot_log() { echo \"opensandbox-worker-bootstrap $(date -Is) $*\"; }\n")
	sb.WriteString("oc_boot_log 'user-data start'\n\n")
	sb.WriteString("systemctl stop opensandbox-worker.service 2>/dev/null || true\n")
	sb.WriteString("systemctl disable opensandbox-worker.service 2>/dev/null || true\n")
	sb.WriteString("systemctl reset-failed opensandbox-worker.service 2>/dev/null || true\n\n")
	sb.WriteString("systemctl stop opensandbox-server.service 2>/dev/null || true\n")
	sb.WriteString("systemctl disable opensandbox-server.service 2>/dev/null || true\n")
	sb.WriteString("systemctl reset-failed opensandbox-server.service 2>/dev/null || true\n\n")

	sb.WriteString("# Instance identity from EC2 metadata (IMDSv2)\n")
	sb.WriteString("TOKEN=$(curl -fsS -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')\n")
	sb.WriteString("MY_IP=$(curl -fsS -H \"X-aws-ec2-metadata-token: $TOKEN\" http://169.254.169.254/latest/meta-data/local-ipv4)\n")
	sb.WriteString("INSTANCE_ID=$(curl -fsS -H \"X-aws-ec2-metadata-token: $TOKEN\" http://169.254.169.254/latest/meta-data/instance-id)\n")
	sb.WriteString("WORKER_ID=\"w-aws-${INSTANCE_ID}\"\n\n")
	sb.WriteString("oc_boot_log \"instance identity ready: $INSTANCE_ID $MY_IP\"\n\n")

	// NVMe instance store handling. Larger metal/x.gd instance families expose
	// multiple NVMe drives at /dev/nvme[1-N]n1; smaller instances rely on EBS
	// (the attached data volume). RAID 0 across instance store NVMe when present.
	sb.WriteString("# Mount data: prefer EC2 instance-store NVMe (RAID 0). Otherwise use root fs for /data.\n")
	sb.WriteString("if ! mountpoint -q /data 2>/dev/null; then\n")
	sb.WriteString("  mkdir -p /data\n")
	sb.WriteString("  ROOT_DEV=$(lsblk -no PKNAME $(findmnt -n -o SOURCE /) 2>/dev/null | head -1)\n")
	sb.WriteString("  NVME_DISKS=()\n")
	sb.WriteString("  while read -r name model; do\n")
	sb.WriteString("    [ -n \"${name:-}\" ] || continue\n")
	sb.WriteString("    [ \"$name\" = \"$ROOT_DEV\" ] && continue\n")
	sb.WriteString("    [ \"$model\" = \"Amazon EC2 NVMe Instance Storage\" ] || continue\n")
	sb.WriteString("    NVME_DISKS+=(\"/dev/$name\")\n")
	sb.WriteString("  done < <(lsblk -dn -o NAME,MODEL)\n")
	sb.WriteString("  if [ ${#NVME_DISKS[@]} -eq 0 ]; then\n")
	sb.WriteString("    echo 'No EC2 instance-store NVMe found; using root filesystem for /data'\n")
	sb.WriteString("  fi\n")
	sb.WriteString("  if [ ${#NVME_DISKS[@]} -gt 1 ]; then\n")
	sb.WriteString("    mdadm --create /dev/md0 --level=0 --raid-devices=${#NVME_DISKS[@]} \"${NVME_DISKS[@]}\" --run --force\n")
	sb.WriteString("    mkfs.xfs -f -m reflink=1 /dev/md0 && mount /dev/md0 /data\n")
	sb.WriteString("  elif [ ${#NVME_DISKS[@]} -eq 1 ]; then\n")
	sb.WriteString("    mkfs.xfs -f -m reflink=1 \"${NVME_DISKS[0]}\" && mount \"${NVME_DISKS[0]}\" /data\n")
	sb.WriteString("  fi\n")
	sb.WriteString("fi\n")
	sb.WriteString("mkdir -p /data/sandboxes /data/firecracker/images\n")
	sb.WriteString("oc_boot_log 'base data mount ready'\n\n")

	if p.cfg.SharedSandboxDataVolumeID != "" {
		sb.WriteString(p.sharedSandboxDataUserData(ocfs2))
	}
	if p.cfg.SharedGoldensVolumeID != "" {
		sb.WriteString(p.sharedGoldensUserData())
	}

	sb.WriteString("# Copy AMI-baked rootfs images to data disk if not already present\n")
	sb.WriteString("if [ -d /opt/opensandbox/images ] && [ ! -f /data/firecracker/images/default.ext4 ]; then\n")
	sb.WriteString("  oc_boot_log 'copying AMI-baked rootfs to data disk'\n")
	sb.WriteString("  cp /opt/opensandbox/images/*.ext4 /data/firecracker/images/ 2>/dev/null || true\n")
	sb.WriteString("fi\n")
	sb.WriteString("if [ -d /opt/opensandbox/images/bases ] && [ ! -d /data/firecracker/images/bases ]; then\n")
	sb.WriteString("  cp -r /opt/opensandbox/images/bases /data/firecracker/images/\n")
	sb.WriteString("fi\n\n")

	// Worker env from injected WorkerSpec.
	p.mu.RLock()
	envContent := BuildWorkerEnv(p.spec)
	p.mu.RUnlock()
	if envContent != "" {
		envB64 := base64.StdEncoding.EncodeToString([]byte(envContent))
		sb.WriteString("# Write worker env (from control plane WorkerSpec)\n")
		sb.WriteString("mkdir -p /etc/opensandbox\n")
		sb.WriteString(fmt.Sprintf("echo '%s' | base64 -d > /etc/opensandbox/worker.env\n\n", envB64))

		sb.WriteString("# Patch worker identity from EC2 instance metadata (IMDSv2)\n")
		sb.WriteString("sed -i \"s|OPENSANDBOX_GRPC_ADVERTISE=.*|OPENSANDBOX_GRPC_ADVERTISE=${MY_IP}:9090|\" /etc/opensandbox/worker.env\n")
		sb.WriteString("sed -i \"s|OPENSANDBOX_HTTP_ADDR=.*|OPENSANDBOX_HTTP_ADDR=http://${MY_IP}:8081|\" /etc/opensandbox/worker.env\n")
		sb.WriteString("sed -i \"s|OPENSANDBOX_WORKER_ID=.*|OPENSANDBOX_WORKER_ID=${WORKER_ID}|\" /etc/opensandbox/worker.env\n")
		sb.WriteString("echo \"OPENSANDBOX_MACHINE_ID=${INSTANCE_ID}\" >> /etc/opensandbox/worker.env\n\n")
	}

	// Clean stale golden snapshot — must rebuild for this instance's QEMU
	sb.WriteString("rm -rf /data/sandboxes/golden-snapshot /data/sandboxes/golden\n\n")

	// Start worker
	sb.WriteString("oc_boot_log 'starting opensandbox-worker service'\n")
	sb.WriteString("systemctl restart opensandbox-worker\n")
	sb.WriteString("oc_boot_log 'user-data complete'\n")

	return sb.String()
}

func (p *EC2Pool) sharedSandboxDataUserData(ocfs2 ocfs2Assignment) string {
	clusterName := p.cfg.OCFS2ClusterName
	if clusterName == "" {
		clusterName = "opensandbox"
	}
	expectedNodes := p.cfg.OCFS2ExpectedNodes
	if expectedNodes <= 0 {
		expectedNodes = 1
	}
	maxNodes := p.cfg.OCFS2MaxNodes
	if maxNodes <= 0 {
		maxNodes = expectedNodes
	}
	if ocfs2.Enabled && maxNodes < len(ocfs2.NodeIPs) {
		maxNodes = len(ocfs2.NodeIPs)
	}
	if maxNodes < expectedNodes {
		maxNodes = expectedNodes
	}

	var sb strings.Builder
	sb.WriteString("# Shared sandbox data: OCFS2 over io2 Multi-Attach\n")
	sb.WriteString("oc_boot_log 'validating baked OCFS2 dependencies'\n")
	sb.WriteString("command -v mount.ocfs2 >/dev/null 2>&1 || { echo 'ERROR: AMI missing ocfs2-tools; rebuild worker AMI'; exit 1; }\n")
	sb.WriteString("modprobe ocfs2 || { echo 'ERROR: AMI missing ocfs2 kernel module; rebuild worker AMI with linux-modules-extra'; exit 1; }\n")
	sb.WriteString("modprobe ocfs2_dlmfs || { echo 'ERROR: AMI missing ocfs2_dlmfs kernel module; rebuild worker AMI'; exit 1; }\n")
	sb.WriteString("modprobe ocfs2_stack_o2cb || { echo 'ERROR: AMI missing ocfs2_stack_o2cb kernel module; rebuild worker AMI'; exit 1; }\n")
	sb.WriteString(fmt.Sprintf("SANDBOX_VOLUME_ID=%q\n", p.cfg.SharedSandboxDataVolumeID))
	sb.WriteString(fmt.Sprintf("OCFS2_CLUSTER_NAME=%q\n", clusterName))
	sb.WriteString(fmt.Sprintf("OCFS2_EXPECTED_NODES=%d\n", expectedNodes))
	sb.WriteString(fmt.Sprintf("OCFS2_MAX_NODES=%d\n", maxNodes))
	if ocfs2.Enabled {
		sb.WriteString(fmt.Sprintf("OCFS2_NODE_SLOT=%d\n", ocfs2.Slot))
		sb.WriteString(fmt.Sprintf("OCFS2_NODE_IP=%q\n", ocfs2.IP))
	}
	sb.WriteString("oc_boot_log \"attaching shared sandbox data volume $SANDBOX_VOLUME_ID\"\n")
	sb.WriteString("aws ec2 attach-volume --region " + shellQuote(p.cfg.Region) + " --volume-id \"$SANDBOX_VOLUME_ID\" --instance-id \"$INSTANCE_ID\" --device /dev/sdg || true\n")
	sb.WriteString("SANDBOX_DEV=\"\"\n")
	sb.WriteString("SANDBOX_VOL_NO_DASH=\"${SANDBOX_VOLUME_ID//-/}\"\n")
	sb.WriteString("for i in $(seq 1 180); do\n")
	sb.WriteString("  if [ -e \"/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${SANDBOX_VOL_NO_DASH}\" ]; then\n")
	sb.WriteString("    SANDBOX_DEV=$(readlink -f \"/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${SANDBOX_VOL_NO_DASH}\")\n")
	sb.WriteString("  elif [ -e \"/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${SANDBOX_VOL_NO_DASH}_1\" ]; then\n")
	sb.WriteString("    SANDBOX_DEV=$(readlink -f \"/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${SANDBOX_VOL_NO_DASH}_1\")\n")
	sb.WriteString("  else\n")
	sb.WriteString("    SANDBOX_DEV=$(lsblk -dn -o NAME,SERIAL | awk -v v=\"$SANDBOX_VOL_NO_DASH\" '$2 == v {print \"/dev/\"$1; exit}')\n")
	sb.WriteString("  fi\n")
	sb.WriteString("  [ -n \"${SANDBOX_DEV:-}\" ] && break\n")
	sb.WriteString("  sleep 1\n")
	sb.WriteString("done\n")
	sb.WriteString("if [ -z \"${SANDBOX_DEV:-}\" ]; then echo \"ERROR: shared sandbox data volume not attached\"; lsblk -o NAME,MODEL,SERIAL,SIZE,FSTYPE,MOUNTPOINT || true; exit 1; fi\n")
	sb.WriteString("SANDBOX_SERIAL=$(lsblk -dn -o SERIAL \"$SANDBOX_DEV\" 2>/dev/null | head -1 || true)\n")
	sb.WriteString("if [ \"$SANDBOX_SERIAL\" != \"$SANDBOX_VOL_NO_DASH\" ]; then echo \"ERROR: $SANDBOX_DEV serial $SANDBOX_SERIAL does not match sandbox volume $SANDBOX_VOLUME_ID\"; lsblk -o NAME,MODEL,SERIAL,SIZE,FSTYPE,MOUNTPOINT || true; exit 1; fi\n")
	sb.WriteString("echo \"Using shared sandbox data volume $SANDBOX_VOLUME_ID at $SANDBOX_DEV\"\n")
	sb.WriteString("oc_boot_log \"shared sandbox data volume visible at $SANDBOX_DEV\"\n")
	sb.WriteString("install -d -m 0755 /etc/ocfs2 /etc/sysconfig\n")
	if ocfs2.Enabled {
		sb.WriteString("oc_boot_log \"using static OCFS2 slot $OCFS2_NODE_SLOT at $OCFS2_NODE_IP\"\n")
		sb.WriteString("OCFS2_NODE_NAMES=()\n")
		sb.WriteString("OCFS2_NODE_IPS=()\n")
		for _, ip := range ocfs2.NodeIPs {
			ip = strings.TrimSpace(ip)
			sb.WriteString(fmt.Sprintf("OCFS2_NODE_NAMES+=(%q)\n", awsPrivateDNSShortName(ip)))
			sb.WriteString(fmt.Sprintf("OCFS2_NODE_IPS+=(%q)\n", ip))
		}
		sb.WriteString("{ echo \"cluster:\"; echo \"  node_count = ${#OCFS2_NODE_IPS[@]}\"; echo \"  name = $OCFS2_CLUSTER_NAME\"; echo \"\"; for i in \"${!OCFS2_NODE_IPS[@]}\"; do echo \"node:\"; echo \"  ip_port = 7777\"; echo \"  ip_address = ${OCFS2_NODE_IPS[$i]}\"; echo \"  number = $i\"; echo \"  name = ${OCFS2_NODE_NAMES[$i]}\"; echo \"  cluster = $OCFS2_CLUSTER_NAME\"; echo \"\"; done; } > /etc/ocfs2/cluster.conf\n")
	} else {
		sb.WriteString("oc_boot_log 'discovering OCFS2 peer nodes'\n")
		sb.WriteString("mapfile -t OCFS2_NODES < <(for i in $(seq 1 60); do aws ec2 describe-instances --region " + shellQuote(p.cfg.Region) + " --filters \"Name=tag:Cell,Values=" + shellEscapedDouble(p.cfg.CellID) + "\" \"Name=tag:Role,Values=worker\" \"Name=instance-state-name,Values=running\" --query 'Reservations[].Instances[].PrivateDnsName' --output text | tr '\\t' '\\n' | awk 'NF { sub(/\\..*/, \"\", $0); print }' | sort -u; break; done)\n")
		sb.WriteString("for i in $(seq 1 60); do\n")
		sb.WriteString("  [ \"${#OCFS2_NODES[@]}\" -ge \"$OCFS2_EXPECTED_NODES\" ] && break\n")
		sb.WriteString("  sleep 2\n")
		sb.WriteString("  mapfile -t OCFS2_NODES < <(aws ec2 describe-instances --region " + shellQuote(p.cfg.Region) + " --filters \"Name=tag:Cell,Values=" + shellEscapedDouble(p.cfg.CellID) + "\" \"Name=tag:Role,Values=worker\" \"Name=instance-state-name,Values=running\" --query 'Reservations[].Instances[].PrivateDnsName' --output text | tr '\\t' '\\n' | awk 'NF { sub(/\\..*/, \"\", $0); print }' | sort -u)\n")
		sb.WriteString("done\n")
		sb.WriteString("if [ \"${#OCFS2_NODES[@]}\" -lt \"$OCFS2_EXPECTED_NODES\" ]; then echo \"ERROR: found ${#OCFS2_NODES[@]} OCFS2 nodes, expected $OCFS2_EXPECTED_NODES\"; exit 1; fi\n")
		sb.WriteString("oc_boot_log \"OCFS2 peer nodes: ${OCFS2_NODES[*]}\"\n")
		sb.WriteString("{ echo \"cluster:\"; echo \"  node_count = ${#OCFS2_NODES[@]}\"; echo \"  name = $OCFS2_CLUSTER_NAME\"; echo \"\"; n=0; for node in \"${OCFS2_NODES[@]}\"; do ip=$(getent ahostsv4 \"$node\" | awk '{print $1; exit}'); [ -n \"${ip:-}\" ] || { echo \"ERROR: could not resolve OCFS2 node $node\"; exit 1; }; echo \"node:\"; echo \"  ip_port = 7777\"; echo \"  ip_address = $ip\"; echo \"  number = $n\"; echo \"  name = $node\"; echo \"  cluster = $OCFS2_CLUSTER_NAME\"; echo \"\"; n=$((n + 1)); done; } > /etc/ocfs2/cluster.conf\n")
	}
	sb.WriteString("cat > /etc/default/o2cb <<EOF\nO2CB_ENABLED=true\nO2CB_BOOTCLUSTER=$OCFS2_CLUSTER_NAME\nO2CB_HEARTBEAT_THRESHOLD=31\nO2CB_IDLE_TIMEOUT_MS=30000\nO2CB_KEEPALIVE_DELAY_MS=2000\nO2CB_RECONNECT_DELAY_MS=2000\nEOF\n")
	sb.WriteString("cp /etc/default/o2cb /etc/sysconfig/o2cb\n")
	sb.WriteString("oc_boot_log 'starting OCFS2 cluster service'\n")
	sb.WriteString("systemctl enable --now o2cb || true\nsystemctl restart o2cb || true\n")
	sb.WriteString("command -v o2cb >/dev/null 2>&1 && o2cb register-cluster \"$OCFS2_CLUSTER_NAME\" || true\n")
	sb.WriteString("[ -x /etc/init.d/o2cb ] && /etc/init.d/o2cb online \"$OCFS2_CLUSTER_NAME\" || true\n")
	sb.WriteString("mkdir -p /data/sandboxes\n")
	sb.WriteString("FSTYPE=$(blkid -s TYPE -o value \"$SANDBOX_DEV\" 2>/dev/null || true)\n")
	sb.WriteString("if [ -z \"$FSTYPE\" ]; then mkfs.ocfs2 -F -N \"$OCFS2_MAX_NODES\" -L opensandbox-sandboxes -T vmstore \"$SANDBOX_DEV\"; fi\n")
	sb.WriteString("FSTYPE=$(blkid -s TYPE -o value \"$SANDBOX_DEV\" 2>/dev/null || true)\n")
	sb.WriteString("if [ \"$FSTYPE\" != \"ocfs2\" ]; then echo \"ERROR: shared sandbox data volume $SANDBOX_DEV has filesystem '$FSTYPE', expected ocfs2\"; lsblk -o NAME,MODEL,SERIAL,SIZE,FSTYPE,MOUNTPOINT || true; exit 1; fi\n")
	sb.WriteString("if ! grep -q 'LABEL=opensandbox-sandboxes' /etc/fstab; then echo 'LABEL=opensandbox-sandboxes /data/sandboxes ocfs2 noauto,_netdev,noatime 0 0' >> /etc/fstab; fi\n")
	sb.WriteString("oc_boot_log 'mounting OCFS2 shared sandbox data volume'\n")
	sb.WriteString("timeout 90 mount -t ocfs2 -o noatime \"$SANDBOX_DEV\" /data/sandboxes\n")
	sb.WriteString("oc_boot_log 'OCFS2 shared sandbox data mounted'\n")
	sb.WriteString("chown root:root /data/sandboxes\n\n")
	return sb.String()
}

func (p *EC2Pool) sharedGoldensUserData() string {
	var sb strings.Builder
	sb.WriteString("# Shared golden image volume\n")
	sb.WriteString("mkdir -p /opt/opensandbox/goldens-shared /var/lib/opensandbox/golden\n")
	sb.WriteString(fmt.Sprintf("GOLDENS_VOLUME_ID=%q\n", p.cfg.SharedGoldensVolumeID))
	sb.WriteString("aws ec2 attach-volume --region " + shellQuote(p.cfg.Region) + " --volume-id \"$GOLDENS_VOLUME_ID\" --instance-id \"$INSTANCE_ID\" --device /dev/sdf || true\n")
	sb.WriteString("GOLDENS_DEV=\"\"\n")
	sb.WriteString("GOLDENS_VOL_NO_DASH=\"${GOLDENS_VOLUME_ID//-/}\"\n")
	sb.WriteString("for i in $(seq 1 120); do\n")
	sb.WriteString("  if [ -e \"/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${GOLDENS_VOL_NO_DASH}\" ]; then GOLDENS_DEV=$(readlink -f \"/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${GOLDENS_VOL_NO_DASH}\"); fi\n")
	sb.WriteString("  if [ -z \"${GOLDENS_DEV:-}\" ] && [ -e \"/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${GOLDENS_VOL_NO_DASH}_1\" ]; then GOLDENS_DEV=$(readlink -f \"/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${GOLDENS_VOL_NO_DASH}_1\"); fi\n")
	sb.WriteString("  if [ -z \"${GOLDENS_DEV:-}\" ]; then GOLDENS_DEV=$(lsblk -dn -o NAME,SERIAL | awk -v v=\"$GOLDENS_VOL_NO_DASH\" '$2 == v {print \"/dev/\"$1; exit}'); fi\n")
	sb.WriteString("  [ -n \"${GOLDENS_DEV:-}\" ] && break\n")
	sb.WriteString("  sleep 1\n")
	sb.WriteString("done\n")
	sb.WriteString("if [ -n \"${GOLDENS_DEV:-}\" ]; then\n")
	sb.WriteString("  GOLDENS_SERIAL=$(lsblk -dn -o SERIAL \"$GOLDENS_DEV\" 2>/dev/null | head -1 || true)\n")
	sb.WriteString("  if [ \"$GOLDENS_SERIAL\" != \"$GOLDENS_VOL_NO_DASH\" ]; then echo \"WARN: $GOLDENS_DEV serial $GOLDENS_SERIAL does not match golden volume $GOLDENS_VOLUME_ID\"; GOLDENS_DEV=\"\"; fi\n")
	sb.WriteString("fi\n")
	sb.WriteString("if [ -n \"${GOLDENS_DEV:-}\" ]; then\n")
	sb.WriteString("  GOLDENS_FSTYPE=$(blkid -s TYPE -o value \"$GOLDENS_DEV\" 2>/dev/null || true)\n")
	sb.WriteString("  case \"$GOLDENS_FSTYPE\" in\n")
	sb.WriteString("    ext2|ext3|ext4) mount -t \"$GOLDENS_FSTYPE\" -o ro,noload,noatime \"$GOLDENS_DEV\" /opt/opensandbox/goldens-shared || true ;;\n")
	sb.WriteString("    xfs) mount -t xfs -o ro,noatime \"$GOLDENS_DEV\" /opt/opensandbox/goldens-shared || true ;;\n")
	sb.WriteString("    '') echo \"WARN: shared golden volume $GOLDENS_VOLUME_ID has no filesystem; continuing without it\" ;;\n")
	sb.WriteString("    *) echo \"WARN: shared golden volume $GOLDENS_VOLUME_ID has unsupported filesystem '$GOLDENS_FSTYPE'; continuing without it\" ;;\n")
	sb.WriteString("  esac\n")
	sb.WriteString("fi\n")
	sb.WriteString("if [ -d /opt/opensandbox/goldens-shared/golden ]; then ln -sfn /opt/opensandbox/goldens-shared/golden /var/lib/opensandbox/golden; fi\n\n")
	return sb.String()
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

func shellEscapedDouble(s string) string {
	return strings.ReplaceAll(s, `"`, `\"`)
}

func awsPrivateDNSShortName(ip string) string {
	return "ip-" + strings.ReplaceAll(strings.TrimSpace(ip), ".", "-")
}
