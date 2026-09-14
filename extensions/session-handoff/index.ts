import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHandoff } from "./handoff";
import { registerSessionName } from "./session-name";

/** Human-only launching and independently usable, model-callable self-naming. */
export default function sessionHandoffExtension(pi: ExtensionAPI): void {
  registerHandoff(pi);
  registerSessionName(pi);
}
