package storage

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3Config holds the configuration for the S3 storage backend.
type S3Config struct {
	Endpoint        string
	Bucket          string
	Region          string
	AccessKeyID     string
	SecretAccessKey string
	ForcePathStyle  bool
}

// CheckpointStore manages checkpoint archives in S3-compatible object storage.
type CheckpointStore struct {
	client *s3.Client
	bucket string
}

// NewCheckpointStore creates a new S3 checkpoint store.
func NewCheckpointStore(cfg S3Config) (*CheckpointStore, error) {
	opts := []func(*s3.Options){
		func(o *s3.Options) {
			o.Region = cfg.Region
			o.Credentials = credentials.NewStaticCredentialsProvider(
				cfg.AccessKeyID, cfg.SecretAccessKey, "",
			)
			if cfg.ForcePathStyle {
				o.UsePathStyle = true
			}
			if cfg.Endpoint != "" {
				o.BaseEndpoint = aws.String(cfg.Endpoint)
			}
		},
	}

	client := s3.New(s3.Options{}, opts...)

	return &CheckpointStore{
		client: client,
		bucket: cfg.Bucket,
	}, nil
}

// CheckpointKey returns the S3 key for a checkpoint archive.
func CheckpointKey(sandboxID string) string {
	return fmt.Sprintf("checkpoints/%s/%d.tar.zst", sandboxID, time.Now().UnixNano())
}

// Upload uploads a checkpoint archive from a local file to S3.
// Returns the size in bytes.
func (s *CheckpointStore) Upload(ctx context.Context, key, localPath string) (int64, error) {
	f, err := os.Open(localPath)
	if err != nil {
		return 0, fmt.Errorf("failed to open checkpoint file: %w", err)
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return 0, fmt.Errorf("failed to stat checkpoint file: %w", err)
	}

	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(key),
		Body:          f,
		ContentLength: aws.Int64(stat.Size()),
	})
	if err != nil {
		return 0, fmt.Errorf("failed to upload checkpoint to S3: %w", err)
	}

	return stat.Size(), nil
}

// Download returns an io.ReadCloser streaming the checkpoint from S3.
// The caller must close the reader when done.
func (s *CheckpointStore) Download(ctx context.Context, key string) (io.ReadCloser, error) {
	resp, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to download checkpoint from S3: %w", err)
	}
	return resp.Body, nil
}

// Delete removes a checkpoint archive from S3.
func (s *CheckpointStore) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("failed to delete checkpoint from S3: %w", err)
	}
	return nil
}
