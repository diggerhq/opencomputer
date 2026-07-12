import { afterEach, describe, expect, it, vi } from "vitest";
import { Browser } from "./browser.js";
import { BrowserProfile } from "./browser.js";

const browserResponse = {
  id: "br_1",
  provider: "kernel",
  provider_session_id: "kernel_1",
  status: "active",
  cdp_ws_url: "wss://proxy.example.onkernel.com/browser/cdp?jwt=abc",
  webdriver_ws_url: "wss://proxy.example.onkernel.com/browser/webdriver/session?jwt=abc",
  live_view_url: "https://proxy.example.onkernel.com/browser/live?jwt=abc",
  base_url: "https://proxy.example.onkernel.com/browser/kernel",
  headless: false,
  stealth: true,
  timeout_seconds: 60,
};

describe("Browser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a browser with OpenComputer browser API shape", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(browserResponse, { status: 201 }),
    );

    const browser = await Browser.create({
      apiKey: "osb_test",
      apiUrl: "https://browser.example.test/",
      stealth: true,
      timeoutSeconds: 120,
      startUrl: "https://example.com",
      telemetry: { enabled: true },
      recording: false,
      viewport: { width: 1280, height: 800, refreshRate: 60 },
      profile: { name: "default", saveChanges: true },
    });

    expect(browser.id).toBe("br_1");
    expect(browser.providerSessionId).toBe("kernel_1");
    expect(browser.cdpWsUrl).toContain("onkernel.com");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://browser.example.test/v1/browsers",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-API-Key": "osb_test" }),
        body: JSON.stringify({
          stealth: true,
          timeout_seconds: 120,
          profile: { name: "default", save_changes: true },
          viewport: { width: 1280, height: 800, refresh_rate: 60 },
          start_url: "https://example.com",
          telemetry: { enabled: true },
          recording: false,
        }),
      }),
    );
  });

  it("connects and deletes a browser", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(browserResponse))
      .mockResolvedValueOnce(Response.json({ id: "br_1", status: "deleted" }));

    const browser = await Browser.connect("br_1", {
      apiKey: "osb_test",
      apiUrl: "https://browser.example.test",
    });
    await browser.delete();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://browser.example.test/v1/browsers/br_1",
      expect.objectContaining({ headers: expect.objectContaining({ "X-API-Key": "osb_test" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://browser.example.test/v1/browsers/br_1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("creates, lists, connects, and deletes browser profiles", async () => {
    const profileResponse = {
      id: "prof_1",
      provider: "kernel",
      provider_profile_id: "kernel_profile_1",
      name: "github-login",
      created_at: "2026-06-27T00:00:00.000Z",
      updated_at: "2026-06-27T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(profileResponse, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ profiles: [profileResponse] }))
      .mockResolvedValueOnce(Response.json(profileResponse))
      .mockResolvedValueOnce(Response.json({ id: "prof_1", status: "deleted" }));

    const profile = await BrowserProfile.create({
      apiKey: "osb_test",
      apiUrl: "https://browser.example.test",
      name: "github-login",
    });
    expect(profile.id).toBe("prof_1");
    expect(profile.providerProfileId).toBe("kernel_profile_1");

    const profiles = await BrowserProfile.list({
      apiKey: "osb_test",
      apiUrl: "https://browser.example.test",
    });
    expect(profiles).toHaveLength(1);

    await BrowserProfile.connect("github-login", {
      apiKey: "osb_test",
      apiUrl: "https://browser.example.test",
    });
    await profile.delete();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://browser.example.test/v1/profiles",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "github-login" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://browser.example.test/v1/profiles/prof_1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
