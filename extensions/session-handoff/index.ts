import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHandoff } from "./handoff";
import { registerSessionName } from "./session-name";

/** Explicitly requested, human-confirmed handoffs and independent stable self-naming. */
export default function sessionHandoffExtension(pi: ExtensionAPI): void {
  registerHandoff(pi);
  registerSessionName(pi);
}
