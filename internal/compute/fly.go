package compute

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

const flyAPIBase = "https://api.machines.dev/v1"

// FlyPool implements the compute pool interface for Fly.io Machines.
type FlyPool struct {
	appName string
	token   string
	client  *http.Client
}

// NewFlyPool creates a Fly.io compute pool.
func NewFlyPool(appName string) (*FlyPool, error) {
	token := os.Getenv("FLY_API_TOKEN")
	if token == "" {
		return nil, fmt.Errorf("FLY_API_TOKEN environment variable is required")
	}
	return &FlyPool{
		appName: appName,
		token:   token,
		client:  &http.Client{},
	}, nil
}

func (p *FlyPool) CreateMachine(ctx context.Context, opts MachineOpts) (*Machine, error) {
	body := map[string]interface{}{
		"config": map[string]interface{}{
			"image": opts.Image,
			"guest": map[string]interface{}{
				"cpu_kind":  "shared",
				"cpus":      2,
				"memory_mb": 2048,
			},
			"services": []map[string]interface{}{
				{
					"ports":         []map[string]interface{}{{"port": 9090, "handlers": []string{"tls", "http"}}},
					"protocol":      "tcp",
					"internal_port": 9090,
				},
			},
		},
		"region": opts.Region,
	}

	data, _ := json.Marshal(body)
	url := fmt.Sprintf("%s/apps/%s/machines", flyAPIBase, p.appName)

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fly API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("fly API returned %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		ID         string `json:"id"`
		PrivateIP  string `json:"private_ip"`
		Region     string `json:"region"`
		State      string `json:"state"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode fly response: %w", err)
	}

	return &Machine{
		ID:       result.ID,
		Addr:     fmt.Sprintf("%s:9090", result.PrivateIP),
		Region:   result.Region,
		Status:   result.State,
		Capacity: 50,
	}, nil
}

func (p *FlyPool) DestroyMachine(ctx context.Context, machineID string) error {
	return p.machineAction(ctx, machineID, "DELETE", "")
}

func (p *FlyPool) StartMachine(ctx context.Context, machineID string) error {
	return p.machineAction(ctx, machineID, "POST", "/start")
}

func (p *FlyPool) StopMachine(ctx context.Context, machineID string) error {
	return p.machineAction(ctx, machineID, "POST", "/stop")
}

func (p *FlyPool) ListMachines(ctx context.Context) ([]*Machine, error) {
	url := fmt.Sprintf("%s/apps/%s/machines", flyAPIBase, p.appName)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+p.token)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fly API request failed: %w", err)
	}
	defer resp.Body.Close()

	var results []struct {
		ID        string `json:"id"`
		PrivateIP string `json:"private_ip"`
		Region    string `json:"region"`
		State     string `json:"state"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&results); err != nil {
		return nil, err
	}

	machines := make([]*Machine, len(results))
	for i, r := range results {
		machines[i] = &Machine{
			ID:     r.ID,
			Addr:   fmt.Sprintf("%s:9090", r.PrivateIP),
			Region: r.Region,
			Status: r.State,
		}
	}
	return machines, nil
}

func (p *FlyPool) HealthCheck(ctx context.Context, machineID string) error {
	url := fmt.Sprintf("%s/apps/%s/machines/%s", flyAPIBase, p.appName, machineID)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+p.token)

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("health check failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("machine %s returned status %d", machineID, resp.StatusCode)
	}
	return nil
}

func (p *FlyPool) SupportedRegions(_ context.Context) ([]string, error) {
	return []string{"iad", "ams", "lhr", "sjc", "nrt", "syd", "cdg", "fra"}, nil
}

func (p *FlyPool) DrainMachine(ctx context.Context, machineID string) error {
	// Stop the machine gracefully (Fly will drain connections)
	return p.StopMachine(ctx, machineID)
}

func (p *FlyPool) machineAction(ctx context.Context, machineID, method, action string) error {
	url := fmt.Sprintf("%s/apps/%s/machines/%s%s", flyAPIBase, p.appName, machineID, action)
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+p.token)

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("fly API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("fly API returned %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}
