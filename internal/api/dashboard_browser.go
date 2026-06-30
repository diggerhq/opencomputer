package api

import (
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/auth"
)

func (s *Server) browserAPIBaseURL() string {
	if s.browserAPIURL != "" {
		return strings.TrimRight(s.browserAPIURL, "/")
	}
	return "https://browser.opencomputer.dev"
}

func (s *Server) dashboardListBrowsers(c echo.Context) error {
	return s.dashboardBrowserProxy(c, "/v1/browsers")
}

func (s *Server) dashboardGetBrowser(c echo.Context) error {
	return s.dashboardBrowserProxy(c, "/v1/browsers/"+url.PathEscape(c.Param("browserId")))
}

func (s *Server) dashboardDeleteBrowser(c echo.Context) error {
	return s.dashboardBrowserProxy(c, "/v1/browsers/"+url.PathEscape(c.Param("browserId")))
}

func (s *Server) dashboardListBrowserProfiles(c echo.Context) error {
	return s.dashboardBrowserProxy(c, "/v1/profiles")
}

func (s *Server) dashboardBrowserProxy(c echo.Context, upstreamPath string) error {
	if s.browserAPISecret == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "browser sessions proxy unavailable: browser API secret not configured",
		})
	}

	orgID, ok := auth.GetOrgID(c)
	if !ok {
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "org context required",
		})
	}

	upstream, err := url.Parse(s.browserAPIBaseURL() + upstreamPath)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "invalid browser upstream URL",
		})
	}
	upstream.RawQuery = c.Request().URL.RawQuery

	req, err := http.NewRequestWithContext(c.Request().Context(), c.Request().Method, upstream.String(), c.Request().Body)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to build browser upstream request",
		})
	}

	for k, v := range c.Request().Header {
		switch strings.ToLower(k) {
		case "authorization", "cookie", "x-api-key", "host", "content-length":
			continue
		}
		req.Header[k] = v
	}
	req.Header.Set("Authorization", "Bearer "+s.browserAPISecret)
	req.Header.Set("X-OpenComputer-Org-Id", orgID.String())
	if userID := auth.GetUserID(c); userID != nil {
		req.Header.Set("X-OpenComputer-User-Id", userID.String())
	}
	if ct := c.Request().Header.Get("Content-Type"); ct != "" {
		req.Header.Set("Content-Type", ct)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("dashboard_browser: upstream call failed: %v", err)
		return c.JSON(http.StatusBadGateway, map[string]string{
			"error": "browser upstream request failed",
		})
	}
	defer resp.Body.Close()

	for k, v := range resp.Header {
		switch strings.ToLower(k) {
		case "transfer-encoding", "connection", "keep-alive":
			continue
		}
		c.Response().Header()[k] = v
	}
	c.Response().WriteHeader(resp.StatusCode)
	_, copyErr := io.Copy(c.Response().Writer, resp.Body)
	return copyErr
}
