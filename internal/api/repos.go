package api

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/db"
)

var repoSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

type createRepoRequest struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

func (s *Server) createRepo(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "database not configured",
		})
	}

	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "authentication required",
		})
	}

	var req createRepoRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body",
		})
	}

	if req.Name == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "name is required",
		})
	}

	// Derive slug from name: lowercase, replace spaces with hyphens
	slug := strings.ToLower(strings.TrimSpace(req.Name))
	slug = strings.ReplaceAll(slug, " ", "-")
	if !repoSlugRe.MatchString(slug) {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid repo name: must be lowercase alphanumeric with hyphens",
		})
	}

	repo, err := s.store.CreateRepository(c.Request().Context(), orgID, req.Name, slug, req.Description)
	if err != nil {
		// Check for duplicate slug
		if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
			return c.JSON(http.StatusConflict, map[string]string{
				"error": "repository already exists",
			})
		}
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to create repository: " + err.Error(),
		})
	}

	// Build clone URL if git domain is configured
	resp := map[string]interface{}{
		"id":            repo.ID,
		"name":          repo.Name,
		"slug":          repo.Slug,
		"description":   repo.Description,
		"defaultBranch": repo.DefaultBranch,
		"createdAt":     repo.CreatedAt,
	}
	if s.gitDomain != "" {
		org, err := s.store.GetOrg(c.Request().Context(), orgID)
		if err == nil {
			resp["cloneUrl"] = "http://" + s.gitDomain + "/" + org.Slug + "/" + repo.Slug + ".git"
		}
	}

	return c.JSON(http.StatusCreated, resp)
}

func (s *Server) listRepos(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "database not configured",
		})
	}

	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "authentication required",
		})
	}

	repos, err := s.store.ListRepositories(c.Request().Context(), orgID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to list repositories",
		})
	}

	if repos == nil {
		repos = []db.Repository{}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"repositories": repos,
	})
}

func (s *Server) getRepoAPI(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "database not configured",
		})
	}

	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "authentication required",
		})
	}

	name := c.Param("name")
	repo, err := s.store.GetRepository(c.Request().Context(), orgID, name)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": "repository not found",
		})
	}

	return c.JSON(http.StatusOK, repo)
}

func (s *Server) deleteRepoAPI(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "database not configured",
		})
	}

	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "authentication required",
		})
	}

	name := c.Param("name")
	if err := s.store.DeleteRepository(c.Request().Context(), orgID, name); err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": "repository not found",
		})
	}

	return c.NoContent(http.StatusNoContent)
}
