import { NoActiveProjectError, readActiveProjectId } from "./active-project.js";

export function infiniteOsWorkspaceId(options: { env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env ?? process.env;
  const explicit = env.GROWTH_OS_WORKSPACE_ID?.trim();
  if (explicit) {
    return explicit;
  }
  const active = readActiveProjectId(env);
  if (active) {
    return active;
  }
  throw new NoActiveProjectError();
}
