import { describe, expect, it } from "vitest";

import {
  GENERAL_MARKETING_PROFILE,
  INTERACTIVE_WORKSPACE_CAPABILITY,
  type InteractiveWorkspaceStatusV1,
} from "@infinite-os/types";
import {
  negotiateInteractiveWorkspace,
  requestedInteractiveWorkspace,
} from "./interactive-protocol.js";

const available: InteractiveWorkspaceStatusV1 = {
  supportedProfiles: [GENERAL_MARKETING_PROFILE],
  availableFeatures: [
    "workspace.app-tools.v1",
    "actions.confirmation.v1",
    "actions.continuation.v1",
  ],
  workspaceAccess: "metadata-only",
};

describe("interactive workspace protocol", () => {
  it("requires descriptor and status capability agreement", () => {
    expect(negotiateInteractiveWorkspace({
      descriptorCapabilities: [INTERACTIVE_WORKSPACE_CAPABILITY],
      statusCapabilities: [INTERACTIVE_WORKSPACE_CAPABILITY],
      status: available,
      requestedProfile: GENERAL_MARKETING_PROFILE,
    })).toEqual({ ok: true, status: available });

    expect(negotiateInteractiveWorkspace({
      descriptorCapabilities: [INTERACTIVE_WORKSPACE_CAPABILITY],
      statusCapabilities: [],
      status: available,
      requestedProfile: GENERAL_MARKETING_PROFILE,
    })).toEqual({ ok: false, reason: "capability_unavailable" });
  });

  it("reports a profile mismatch instead of silently changing profile", () => {
    expect(negotiateInteractiveWorkspace({
      descriptorCapabilities: [INTERACTIVE_WORKSPACE_CAPABILITY],
      statusCapabilities: [INTERACTIVE_WORKSPACE_CAPABILITY],
      status: { ...available, supportedProfiles: [] },
      requestedProfile: GENERAL_MARKETING_PROFILE,
    })).toEqual({ ok: false, reason: "profile_unsupported" });
  });

  it("builds only the metadata-only v1 request envelope", () => {
    expect(requestedInteractiveWorkspace({
      profile: GENERAL_MARKETING_PROFILE,
      cwd: "/Users/example/project",
    })).toEqual({
      profile: GENERAL_MARKETING_PROFILE,
      cwd: "/Users/example/project",
    });
  });
});
