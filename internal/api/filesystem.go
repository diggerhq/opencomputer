package api

import (
	"context"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

func (s *Server) readFile(c echo.Context) error {
	id := c.Param("id")

	// Verify the caller owns this sandbox
	if _, err := s.requireSandboxOwnership(c, id); err != nil {
		return err
	}

	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	// Server mode: dispatch to worker via gRPC
	if s.workerRegistry != nil {
		return s.readFileRemote(c, id, path)
	}

	if s.manager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	var content string

	routeOp := func(ctx context.Context) error {
		var err error
		content, err = s.manager.ReadFile(ctx, id, path)
		return err
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "readFile", routeOp); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	}

	return c.String(http.StatusOK, content)
}

func (s *Server) readFileRemote(c echo.Context, sandboxID, path string) error {
	session, err := s.store.GetSandboxSession(c.Request().Context(), sandboxID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "sandbox not found"})
	}

	client, err := s.workerRegistry.GetWorkerClient(session.WorkerID)
	if err != nil {
		log.Printf("filesystem: worker %s unreachable for readFile: %v", session.WorkerID, err)
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "worker unreachable"})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 30*time.Second)
	defer cancel()

	resp, err := client.ReadFile(ctx, &pb.ReadFileRequest{SandboxId: sandboxID, Path: path})
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}

	return c.String(http.StatusOK, string(resp.Content))
}

func (s *Server) writeFile(c echo.Context) error {
	id := c.Param("id")

	// Verify the caller owns this sandbox
	if _, err := s.requireSandboxOwnership(c, id); err != nil {
		return err
	}

	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "failed to read request body: " + err.Error(),
		})
	}

	// Server mode: dispatch to worker via gRPC
	if s.workerRegistry != nil {
		return s.writeFileRemote(c, id, path, body)
	}

	if s.manager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	routeOp := func(ctx context.Context) error {
		return s.manager.WriteFile(ctx, id, path, string(body))
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "writeFile", routeOp); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	}

	return c.NoContent(http.StatusNoContent)
}

func (s *Server) writeFileRemote(c echo.Context, sandboxID, path string, content []byte) error {
	session, err := s.store.GetSandboxSession(c.Request().Context(), sandboxID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "sandbox not found"})
	}

	client, err := s.workerRegistry.GetWorkerClient(session.WorkerID)
	if err != nil {
		log.Printf("filesystem: worker %s unreachable for writeFile: %v", session.WorkerID, err)
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "worker unreachable"})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 30*time.Second)
	defer cancel()

	_, err = client.WriteFile(ctx, &pb.WriteFileRequest{SandboxId: sandboxID, Path: path, Content: content})
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}

	return c.NoContent(http.StatusNoContent)
}

func (s *Server) listDir(c echo.Context) error {
	id := c.Param("id")

	// Verify the caller owns this sandbox
	if _, err := s.requireSandboxOwnership(c, id); err != nil {
		return err
	}

	path := c.QueryParam("path")
	if path == "" {
		path = "/"
	}

	// Server mode: dispatch to worker via gRPC
	if s.workerRegistry != nil {
		return s.listDirRemote(c, id, path)
	}

	if s.manager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	var entries []types.EntryInfo

	routeOp := func(ctx context.Context) error {
		var err error
		entries, err = s.manager.ListDir(ctx, id, path)
		return err
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "listDir", routeOp); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	}

	return c.JSON(http.StatusOK, entries)
}

func (s *Server) listDirRemote(c echo.Context, sandboxID, path string) error {
	session, err := s.store.GetSandboxSession(c.Request().Context(), sandboxID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "sandbox not found"})
	}

	client, err := s.workerRegistry.GetWorkerClient(session.WorkerID)
	if err != nil {
		log.Printf("filesystem: worker %s unreachable for listDir: %v", session.WorkerID, err)
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "worker unreachable"})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 30*time.Second)
	defer cancel()

	resp, err := client.ListDir(ctx, &pb.ListDirRequest{SandboxId: sandboxID, Path: path})
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}

	var entries []types.EntryInfo
	for _, e := range resp.Entries {
		entries = append(entries, types.EntryInfo{
			Name:  e.Name,
			IsDir: e.IsDir,
			Size:  e.Size,
		})
	}

	return c.JSON(http.StatusOK, entries)
}

func (s *Server) makeDir(c echo.Context) error {
	id := c.Param("id")

	// Verify the caller owns this sandbox
	if _, err := s.requireSandboxOwnership(c, id); err != nil {
		return err
	}

	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	// Server mode: dispatch to worker via gRPC
	if s.workerRegistry != nil {
		return s.makeDirRemote(c, id, path)
	}

	if s.manager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	routeOp := func(ctx context.Context) error {
		return s.manager.MakeDir(ctx, id, path)
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "makeDir", routeOp); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	}

	return c.NoContent(http.StatusNoContent)
}

func (s *Server) makeDirRemote(c echo.Context, sandboxID, path string) error {
	session, err := s.store.GetSandboxSession(c.Request().Context(), sandboxID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "sandbox not found"})
	}

	client, err := s.workerRegistry.GetWorkerClient(session.WorkerID)
	if err != nil {
		log.Printf("filesystem: worker %s unreachable for makeDir: %v", session.WorkerID, err)
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "worker unreachable"})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 30*time.Second)
	defer cancel()

	_, err = client.ExecCommand(ctx, &pb.ExecCommandRequest{
		SandboxId: sandboxID,
		Command:   "mkdir",
		Args:      []string{"-p", path},
	})
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}

	return c.NoContent(http.StatusNoContent)
}

func (s *Server) removeFile(c echo.Context) error {
	id := c.Param("id")

	// Verify the caller owns this sandbox
	if _, err := s.requireSandboxOwnership(c, id); err != nil {
		return err
	}

	path := c.QueryParam("path")
	if path == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "path query parameter is required",
		})
	}

	// Server mode: dispatch to worker via gRPC
	if s.workerRegistry != nil {
		return s.removeFileRemote(c, id, path)
	}

	if s.manager == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	routeOp := func(ctx context.Context) error {
		return s.manager.Remove(ctx, id, path)
	}

	if s.router != nil {
		if err := s.router.Route(c.Request().Context(), id, "removeFile", routeOp); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	} else {
		if err := routeOp(c.Request().Context()); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
		}
	}

	return c.NoContent(http.StatusNoContent)
}

func (s *Server) removeFileRemote(c echo.Context, sandboxID, path string) error {
	session, err := s.store.GetSandboxSession(c.Request().Context(), sandboxID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "sandbox not found"})
	}

	client, err := s.workerRegistry.GetWorkerClient(session.WorkerID)
	if err != nil {
		log.Printf("filesystem: worker %s unreachable for removeFile: %v", session.WorkerID, err)
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "worker unreachable"})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 30*time.Second)
	defer cancel()

	// Use exec to remove since there's no dedicated gRPC call for remove
	_, err = client.ExecCommand(ctx, &pb.ExecCommandRequest{
		SandboxId: sandboxID,
		Command:   "rm",
		Args:      []string{"-rf", path},
	})
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}

	return c.NoContent(http.StatusNoContent)
}
