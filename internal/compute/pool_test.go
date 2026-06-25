package compute

import (
	"strings"
	"testing"
)

func TestBuildWorkerEnvIncludesCloudDiskRootConfig(t *testing.T) {
	env := BuildWorkerEnv(WorkerSpec{
		RootDiskBackend:         "cloud-disk",
		CloudDiskCLIPath:        "/usr/local/bin/cloud-disk",
		CloudDiskCachePath:      "/data/cloud-disk-cache",
		CloudDiskDefaultSizeMB:  51200,
		CloudDiskGoldenDisk:     "golden-root",
		CloudDiskGoldenSnapshot: "snap-123",
		CloudDiskS3Endpoint:     "https://t3.storage.dev",
		CloudDiskS3Region:       "auto",
		CloudDiskS3AccessKeyID:  "tid_test",
		CloudDiskS3SecretKey:    "tsec_test",
	})

	for _, want := range []string{
		"OPENSANDBOX_ROOT_DISK_BACKEND=cloud-disk\n",
		"OPENSANDBOX_CLOUD_DISK_CLI_PATH=/usr/local/bin/cloud-disk\n",
		"OPENSANDBOX_CLOUD_DISK_CACHE_PATH=/data/cloud-disk-cache\n",
		"OPENSANDBOX_CLOUD_DISK_DEFAULT_SIZE_MB=51200\n",
		"OPENSANDBOX_CLOUD_DISK_GOLDEN_DISK=golden-root\n",
		"OPENSANDBOX_CLOUD_DISK_GOLDEN_SNAPSHOT=snap-123\n",
		"OPENSANDBOX_CLOUD_DISK_S3_ENDPOINT=https://t3.storage.dev\n",
		"OPENSANDBOX_CLOUD_DISK_S3_REGION=auto\n",
		"OPENSANDBOX_CLOUD_DISK_S3_ACCESS_KEY_ID=tid_test\n",
		"OPENSANDBOX_CLOUD_DISK_S3_SECRET_ACCESS_KEY=tsec_test\n",
	} {
		if !strings.Contains(env, want) {
			t.Fatalf("BuildWorkerEnv() missing %q in:\n%s", want, env)
		}
	}
}
