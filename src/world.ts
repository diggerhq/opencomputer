import Sandbox from "./sandbox.js"
import type { CreateVMResponse } from "./types.js"

type CreateResult = 
    | { success: true; sandbox: Sandbox }
    | { success: false; error: string };

type ListResult =
    | { success: true; vms: Array<{ name: string; status: string }> }
    | { success: false; error: string };

class World {
    constructor(
        private readonly api_key: string,
        private readonly base_url: string = "http://localhost:4000"
    ) {}

    private get headers(): HeadersInit {
        return {
            "Content-Type": "application/json",
            "x-api-key": this.api_key,
        };
    }

    async create(name: string): Promise<CreateResult> {
        try {
            const response = await fetch(`${this.base_url}/vms`, {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify({ name }),
            });

            if (!response.ok) {
                const data = await response.json();
                return { success: false, error: data.error ?? `HTTP ${response.status}` };
            }

            const data: CreateVMResponse = await response.json();
            const sandbox = new Sandbox(data.name, this.api_key, this.base_url);
            
            return { success: true, sandbox };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
        }
    }

    async list(): Promise<ListResult> {
        try {
            const response = await fetch(`${this.base_url}/vms`, {
                method: "GET",
                headers: this.headers,
            });

            if (!response.ok) {
                const data = await response.json();
                return { success: false, error: data.error ?? `HTTP ${response.status}` };
            }

            const data = await response.json();
            return { success: true, vms: data.vms };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
        }
    }

    sandbox(name: string): Sandbox {
        return new Sandbox(name, this.api_key, this.base_url);
    }
}

export default World
