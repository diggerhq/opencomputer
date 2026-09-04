package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/pkg/types"
)

func (s *Server) readFile(c echo.Context) error {
	mgr := s.managerFor(c)
	if mgr == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	id := c.Param("id")
	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	var reader io.ReadCloser
	var totalSize int64

	routeOp := func(ctx context.Context) error {
		var err error
		reader, totalSize, err = mgr.ReadFileStream(ctx, id, path)
		return err
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "readFile", routeOp); err != nil {
			return respondFSErr(c, err)
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return respondFSErr(c, err)
		}
	}
	defer reader.Close()

	resp := c.Response()
	resp.Header().Set("Content-Type", "application/octet-stream")
	if totalSize > 0 {
		resp.Header().Set("Content-Length", fmt.Sprintf("%d", totalSize))
	}
	resp.WriteHeader(http.StatusOK)
	_, err := io.Copy(resp.Writer, reader)
	return err
}

func (s *Server) writeFile(c echo.Context) error {
	mgr := s.managerFor(c)
	if mgr == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	id := c.Param("id")
	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	routeOp := func(ctx context.Context) error {
		_, err := mgr.WriteFileStream(ctx, id, path, 0644, c.Request().Body)
		return err
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "writeFile", routeOp); err != nil {
			return respondFSErr(c, err)
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return respondFSErr(c, err)
		}
	}

	return c.NoContent(http.StatusNoContent)
}

func (s *Server) listDir(c echo.Context) error {
	mgr := s.managerFor(c)
	if mgr == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	id := c.Param("id")
	path := c.QueryParam("path")
	if path == "" {
		path = "/"
	}

	var entries []types.EntryInfo

	routeOp := func(ctx context.Context) error {
		var err error
		entries, err = mgr.ListDir(ctx, id, path)
		return err
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "listDir", routeOp); err != nil {
			return respondFSErr(c, err)
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return respondFSErr(c, err)
		}
	}

	return c.JSON(http.StatusOK, entries)
}

func (s *Server) makeDir(c echo.Context) error {
	mgr := s.managerFor(c)
	if mgr == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	id := c.Param("id")
	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	routeOp := func(ctx context.Context) error {
		return mgr.MakeDir(ctx, id, path)
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "makeDir", routeOp); err != nil {
			return respondFSErr(c, err)
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return respondFSErr(c, err)
		}
	}

	return c.NoContent(http.StatusNoContent)
}

func (s *Server) removeFile(c echo.Context) error {
	mgr := s.managerFor(c)
	if mgr == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	id := c.Param("id")
	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	routeOp := func(ctx context.Context) error {
		return mgr.Remove(ctx, id, path)
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "removeFile", routeOp); err != nil {
			return respondFSErr(c, err)
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return respondFSErr(c, err)
		}
	}

	return c.NoContent(http.StatusNoContent)
}

// respondFSErr answers a filesystem failure with the status the runtime
// reported, falling back to 500.
//
// ADDITIVE ON PURPOSE. Every one of these sites used to be an unconditional
// 500, which made "no such file" indistinguishable from "the sandbox is
// broken" — the SDK cannot tell which to retry, and a caller polling for a file
// that will never exist retries forever. Only an error that actually carries a
// status is treated differently, and today that is exactly the MicroVM guest
// (see awsvmlite's httpError, which preserves the code the agent's gRPC status
// was mapped to). The QEMU fleet's errors do not implement this interface, so
// its responses are byte-for-byte what they were.
func respondFSErr(c echo.Context, err error) error {
	var coded interface{ StatusCode() int }
	if errors.As(err, &coded) {
		if code := coded.StatusCode(); code >= 400 && code < 600 {
			return c.JSON(code, map[string]string{"error": err.Error()})
		}
	}
	return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
}
