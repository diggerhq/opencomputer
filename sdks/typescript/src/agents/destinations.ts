import type { Http, Query } from "./http.js";
import type { Destination, Delivery, DeliveryStatus, Level } from "./types.js";

export interface CreateDestinationParams {
  url: string;
  /** Signing secret (write-only). */
  secret?: string;
  level?: Level;
  /** Event-type allow-list (exact or `prefix.*`); default all. */
  types?: string[];
  includeRaw?: boolean;
  enabled?: boolean;
}

export interface UpdateDestinationParams {
  enabled?: boolean;
  level?: Level;
  types?: string[];
  secret?: string;
}

/** Webhook destinations for one session. Management — needs the org key. */
export class Destinations {
  constructor(private readonly http: Http, private readonly sessionId: string) {}

  create(params: CreateDestinationParams): Promise<Destination> {
    return this.http.request("POST", `/sessions/${this.sessionId}/destinations`, { body: params });
  }
  async list(): Promise<Destination[]> {
    const r = await this.http.request<{ data?: Destination[] } | Destination[]>("GET", `/sessions/${this.sessionId}/destinations`);
    return Array.isArray(r) ? r : r.data ?? [];
  }
  get(id: string): Promise<Destination> {
    return this.http.request("GET", `/sessions/${this.sessionId}/destinations/${id}`);
  }
  update(id: string, params: UpdateDestinationParams): Promise<Destination> {
    return this.http.request("PATCH", `/sessions/${this.sessionId}/destinations/${id}`, { body: params });
  }
  delete(id: string): Promise<void> {
    return this.http.request("DELETE", `/sessions/${this.sessionId}/destinations/${id}`);
  }
}

/** Delivery records (the deliveries control surface) for one session. Needs the org key. */
export class Deliveries {
  constructor(private readonly http: Http, private readonly sessionId: string) {}

  async list(params: { destination?: string; status?: DeliveryStatus } = {}): Promise<Delivery[]> {
    const r = await this.http.request<{ data?: Delivery[] } | Delivery[]>(
      "GET", `/sessions/${this.sessionId}/deliveries`, { query: params as Query },
    );
    return Array.isArray(r) ? r : r.data ?? [];
  }
  get(id: string): Promise<Delivery> {
    return this.http.request("GET", `/sessions/${this.sessionId}/deliveries/${id}`);
  }
  /** Re-send any delivery (not just dead-lettered). */
  redeliver(id: string): Promise<void> {
    return this.http.request("POST", `/sessions/${this.sessionId}/deliveries/${id}/redeliver`);
  }
}
