import type { CommandResult, SnapshotsResult, VMInfoResult, SimpleResult } from "./types.js"

class Sandbox {
    constructor(
        public readonly name: string,
        private readonly api_key: string,
        private readonly base_url: string = "http://localhost:4000"
    ) {}

    private get headers(): HeadersInit {
        return {
            "Content-Type": "application/json",
            "x-api-key": this.api_key,
        };
    }

    async run(command: string): Promise<CommandResult> {
        try {
            const response = await fetch(`${this.base_url}/vms/${this.name}/run`, {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify({ command }),
            });

            if (!response.ok) {
                const data = await response.json();
                return { success: false, error: data.error ?? `HTTP ${response.status}` };
            }

            const data = await response.json();
            return { 
                success: true, 
                stdout: data.stdout, 
                stderr: data.stderr, 
                exitCode: data.exitCode,
                snapshot: data.snapshot,
            };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
        }
    }

    async info(): Promise<VMInfoResult> {
        try {
            const response = await fetch(`${this.base_url}/vms/${this.name}`, {
                method: "GET",
                headers: this.headers,
            });

            if (!response.ok) {
                const data = await response.json();
                return { success: false, error: data.error ?? `HTTP ${response.status}` };
            }

            const vm = await response.json();
            return { success: true, vm };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
        }
    }

    async destroy(): Promise<SimpleResult> {
        try {
            const response = await fetch(`${this.base_url}/vms/${this.name}`, {
                method: "DELETE",
                headers: this.headers,
            });

            if (!response.ok) {
                const data = await response.json();
                return { success: false, error: data.error ?? `HTTP ${response.status}` };
            }

            const data = await response.json();
            return { success: true, message: data.message };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
        }
    }

    async wipe(): Promise<SimpleResult> {
        try {
            const response = await fetch(`${this.base_url}/vms/${this.name}/wipe`, {
                method: "POST",
                headers: this.headers,
            });

            if (!response.ok) {
                const data = await response.json();
                return { success: false, error: data.error ?? `HTTP ${response.status}` };
            }

            const data = await response.json();
            return { success: true, message: data.message };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
        }
    }

    async snapshots(): Promise<SnapshotsResult> {
        try {
            const response = await fetch(`${this.base_url}/vms/${this.name}/snapshots`, {
                method: "GET",
                headers: this.headers,
            });

            if (!response.ok) {
                const data = await response.json();
                return { success: false, error: data.error ?? `HTTP ${response.status}` };
            }

            const data = await response.json();
            return { success: true, snapshots: data.snapshots };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
        }
    }

    async restore(snapshot_name: string): Promise<SimpleResult> {
        try {
            const response = await fetch(
                `${this.base_url}/vms/${this.name}/snapshots/${snapshot_name}/restore`,
                {
                    method: "POST",
                    headers: this.headers,
                }
            );

            if (!response.ok) {
                const data = await response.json();
                return { success: false, error: data.error ?? `HTTP ${response.status}` };
            }

            const data = await response.json();
            return { success: true, message: data.message };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
        }
    }
}

export default Sandbox
