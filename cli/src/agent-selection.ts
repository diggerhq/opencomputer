import { cloudAgentId, type ProjectBinding } from "./binding.js";
import { CLIError } from "./errors.js";
import type { ProjectAgentSource } from "./project.js";

/** One member of a project: its local source and the cloud agent it deploys as (`null` until the project is linked). */
export interface ProjectAgentMember {
  localId: string;
  agentId: string | null;
  root: string;
  index: number;
}

/** What the user asked for: the cloud agent (`--agent`) and/or the local source member (`--local-agent`). */
export interface AgentSelector {
  agent?: string;
  localAgent?: string;
}

export function projectAgentMembers(
  agents: readonly ProjectAgentSource[],
  binding: Pick<ProjectBinding, "agentId"> | null,
): ProjectAgentMember[] {
  return agents.map((agent, index) => ({
    localId: agent.localId,
    agentId: binding ? cloudAgentId(binding, agent.localId, index) : null,
    root: agent.root,
    index,
  }));
}

function roster(members: readonly ProjectAgentMember[]): string {
  return members
    .map((member) =>
      member.agentId && member.agentId !== member.localId
        ? `${member.localId} (cloud agent ${member.agentId})`
        : member.localId,
    )
    .join(", ");
}

function details(members: readonly ProjectAgentMember[], selector: AgentSelector) {
  return {
    selector,
    localAgents: members.map((member) => member.localId),
    agents: members.map(({ localId, agentId }) => ({ localId, agentId })),
  };
}

/**
 * The one project member a command works on. `--agent` matches the member's
 * cloud id (or its local id when the two coincide); `--local-agent` names the
 * local id outright and, when both are given, must map to that cloud agent.
 * Without a selector the sole member is chosen; several members are never
 * narrowed silently.
 */
export function selectProjectAgent(
  members: readonly ProjectAgentMember[],
  selector: AgentSelector = {},
): ProjectAgentMember {
  if (!members.length) {
    throw new CLIError(
      "local_agent_not_found",
      "This project declares no agents.",
      "Add an agent to opencomputer/project.ts, or run `opencomputer init <directory>`.",
      details(members, selector),
    );
  }
  if (selector.localAgent) {
    const member = members.find((candidate) => candidate.localId === selector.localAgent);
    if (!member) {
      throw new CLIError(
        "local_agent_not_found",
        `No local agent ${selector.localAgent} in this project. Local agents: ${roster(members)}.`,
        "Pass --local-agent with one of the listed local agent IDs from opencomputer/project.ts.",
        details(members, selector),
      );
    }
    if (
      selector.agent &&
      member.agentId !== null &&
      selector.agent !== member.agentId &&
      selector.agent !== member.localId
    ) {
      throw new CLIError(
        "agent_selection_mismatch",
        `Local agent ${member.localId} deploys as cloud agent ${member.agentId}, not ${selector.agent}.`,
        `Pass --agent ${member.agentId} with --local-agent ${member.localId}, or drop one of the flags.`,
        details(members, selector),
      );
    }
    return member;
  }
  if (selector.agent) {
    const matches = members.filter(
      (candidate) =>
        candidate.agentId === selector.agent || candidate.localId === selector.agent,
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new CLIError(
        "local_agent_ambiguous",
        `--agent ${selector.agent} matches several local agents: ${roster(matches)}.`,
        "Add --local-agent <local-agent-id> to name the local source to use.",
        details(members, selector),
      );
    }
    throw new CLIError(
      "local_agent_not_found",
      `--agent ${selector.agent} does not map to a local agent in this project. Local agents: ${roster(members)}.`,
      "Add --local-agent <local-agent-id> to name the local source for this cloud agent.",
      details(members, selector),
    );
  }
  if (members.length === 1) return members[0]!;
  throw new CLIError(
    "local_agent_required",
    `This project has ${String(members.length)} agents; choose one. Local agents: ${roster(members)}.`,
    "Pass --agent <cloud-agent-id> or --local-agent <local-agent-id>.",
    details(members, selector),
  );
}
