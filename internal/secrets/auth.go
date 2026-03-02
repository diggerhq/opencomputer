package secrets

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

// APIKeyInterceptor returns a gRPC unary interceptor that validates an API key
// sent in the "authorization" metadata header. The key is compared against a
// pre-computed SHA-256 hash using constant-time comparison to prevent timing attacks.
func APIKeyInterceptor(apiKeyHash [32]byte) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			return nil, status.Error(codes.Unauthenticated, "missing metadata")
		}

		keys := md.Get("authorization")
		if len(keys) == 0 {
			return nil, status.Error(codes.Unauthenticated, "missing authorization header")
		}

		provided := sha256.Sum256([]byte(keys[0]))
		if !hmac.Equal(provided[:], apiKeyHash[:]) {
			return nil, status.Error(codes.Unauthenticated, "invalid API key")
		}

		return handler(ctx, req)
	}
}

// LoggingInterceptor returns a gRPC unary interceptor that logs each RPC call
// with method, caller address, duration, and status code.
func LoggingInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		start := time.Now()

		caller := "unknown"
		if p, ok := peer.FromContext(ctx); ok {
			caller = p.Addr.String()
		}

		resp, err := handler(ctx, req)

		code := codes.OK
		if err != nil {
			if st, ok := status.FromError(err); ok {
				code = st.Code()
			} else {
				code = codes.Internal
			}
		}

		log.Printf("secrets-server: audit method=%s caller=%s status=%s duration=%s",
			info.FullMethod, caller, code, time.Since(start))

		return resp, err
	}
}

// HashAPIKey computes the SHA-256 hash of an API key for use with APIKeyInterceptor.
func HashAPIKey(apiKey string) [32]byte {
	return sha256.Sum256([]byte(apiKey))
}
