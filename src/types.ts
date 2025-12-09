// API Response Types

export type CommandResult = 
  | { success: true; stdout: string; stderr: string; exitCode: number; snapshot: string }
  | { success: false; error: string };

export type Snapshot = {
  id: number;
  vm_name: string;
  snapshot_name: string;
  command: string | null;
  created_at: string;
};

export type SnapshotsResult =
  | { success: true; snapshots: Snapshot[] }
  | { success: false; error: string };

export type VMInfo = {
  id: number;
  name: string;
  base_vm: string;
  status: string;
  agent_port: number;
  ssh_port: number;
  created_at: string;
  updated_at: string;
  agentHealthy: boolean;
};

export type VMInfoResult =
  | { success: true; vm: VMInfo }
  | { success: false; error: string };

export type SimpleResult =
  | { success: true; message: string }
  | { success: false; error: string };

export type CreateVMResponse = {
  id: number;
  name: string;
  api_key: string;
  base_vm: string;
  status: string;
  agent_port: number;
  ssh_port: number;
  created_at: string;
  updated_at: string;
};
