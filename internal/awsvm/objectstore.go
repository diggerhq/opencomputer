package awsvm

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3Store is the ObjectStore the template builder reads and writes build
// artifacts through.
//
// Deliberately tiny — Get and Put on an s3:// URI, nothing else. The builder
// only ever fetches the base image's artifact and uploads a derived one, so a
// broader surface would only be an invitation to reach for S3 from places that
// should not.
type S3Store struct {
	api *s3.Client
}

// NewS3Store builds a store from the same aws.Config the MicroVM client uses,
// so credentials and region cannot drift between the two.
func NewS3Store(cfg aws.Config) *S3Store {
	return &S3Store{api: s3.NewFromConfig(cfg)}
}

// parseS3URI splits s3://bucket/key.
//
// Returns an error rather than guessing: these URIs come from an AWS API
// response (the base image's code artifact) and from config, and a silently
// mis-parsed bucket would surface as a NoSuchBucket naming something the
// operator never typed.
func parseS3URI(uri string) (bucket, key string, err error) {
	const scheme = "s3://"
	if !strings.HasPrefix(uri, scheme) {
		return "", "", fmt.Errorf("not an s3:// URI: %q", uri)
	}
	rest := strings.TrimPrefix(uri, scheme)
	i := strings.Index(rest, "/")
	if i <= 0 || i == len(rest)-1 {
		return "", "", fmt.Errorf("s3 URI %q has no bucket/key split", uri)
	}
	return rest[:i], rest[i+1:], nil
}

func (s *S3Store) Get(ctx context.Context, uri string) ([]byte, error) {
	bucket, key, err := parseS3URI(uri)
	if err != nil {
		return nil, err
	}
	out, err := s.api.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", uri, err)
	}
	defer out.Body.Close()
	return io.ReadAll(out.Body)
}

func (s *S3Store) Put(ctx context.Context, uri string, body []byte) error {
	bucket, key, err := parseS3URI(uri)
	if err != nil {
		return err
	}
	if _, err := s.api.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(key),
		Body: bytes.NewReader(body),
	}); err != nil {
		return fmt.Errorf("put %s: %w", uri, err)
	}
	return nil
}
