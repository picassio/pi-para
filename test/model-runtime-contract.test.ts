import { describe, expect, it, vi } from "vitest";

const events: string[] = [];
const getAuth = vi.fn(async () => ({ auth: { apiKey: "fake-key" } }));
const runtime = { getAuth };

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: vi.fn(async (options) => {
      events.push(`runtime:${String(options.allowModelNetwork)}`);
      return runtime;
    }),
  },
  ModelRegistry: class {
    constructor(received: unknown) {
      expect(received).toBe(runtime);
      events.push("registry");
    }
    async refresh() { events.push("refresh:start"); await Promise.resolve(); events.push("refresh:end"); }
    getAll() { events.push("read"); return []; }
    getAvailable() { return []; }
    find() { return undefined; }
    async getApiKeyForProvider() { return undefined; }
  },
  readStoredCredential: vi.fn((provider: string) => provider === "anthropic" ? { type: "api_key", key: "fake-key" } : undefined),
}));

describe("Pi 0.80.10 model runtime contract", () => {
  it("awaits offline runtime creation and registry refresh before synchronous reads", async () => {
    const { createPiModelServices } = await import("../src/model-resolver.js");
    const services = await createPiModelServices({ authPath: "/tmp/fake-auth.json" });
    expect(services).not.toBeNull();
    services!.modelRegistry.getAll();
    expect(events).toEqual(["runtime:false", "registry", "refresh:start", "refresh:end", "read"]);
    expect(services!.credentials.hasStoredCredential("anthropic")).toBe(true);
    expect(await services!.credentials.getApiKey("anthropic")).toBe("fake-key");
    expect(await services!.credentials.getApiKey("missing")).toBeUndefined();
    expect(getAuth).toHaveBeenCalledTimes(1);
  });
});
