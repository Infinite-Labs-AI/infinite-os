import {
  type InteractiveAgentProfile,
  type InteractiveWorkspaceRequestV1,
  type InteractiveWorkspaceStatusV1,
  INTERACTIVE_WORKSPACE_CAPABILITY,
} from "@infinite-os/types";

export type InteractiveWorkspaceNegotiation =
  | { ok: true; status: InteractiveWorkspaceStatusV1 }
  | { ok: false; reason: "capability_unavailable" | "profile_unsupported" };

export function negotiateInteractiveWorkspace(input: {
  descriptorCapabilities: readonly string[];
  statusCapabilities: readonly string[];
  status?: InteractiveWorkspaceStatusV1;
  requestedProfile: InteractiveAgentProfile;
}): InteractiveWorkspaceNegotiation {
  if (
    !input.descriptorCapabilities.includes(INTERACTIVE_WORKSPACE_CAPABILITY) ||
    !input.statusCapabilities.includes(INTERACTIVE_WORKSPACE_CAPABILITY) ||
    !input.status
  ) {
    return { ok: false, reason: "capability_unavailable" };
  }
  if (!input.status.supportedProfiles.includes(input.requestedProfile)) {
    return { ok: false, reason: "profile_unsupported" };
  }
  return { ok: true, status: input.status };
}

export function requestedInteractiveWorkspace(input: {
  profile: InteractiveAgentProfile;
  cwd?: string;
}): InteractiveWorkspaceRequestV1 {
  return {
    profile: input.profile,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  };
}
