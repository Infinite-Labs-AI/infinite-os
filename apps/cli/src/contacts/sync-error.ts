/**
 * Typed failure for the contacts-sync flow (`infinite contacts sync`).
 *
 * Every message is written for the terminal and MUST be safe to print: no
 * service keys, no bearer tokens, no raw auth.users row content — the flow's
 * hard rule is that credentials and people-data never appear in error output.
 */
export class ContactsSyncError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ContactsSyncError";
  }
}
