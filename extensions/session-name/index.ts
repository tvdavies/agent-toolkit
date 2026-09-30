import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionName } from "./session-name";

/** Stable, human-overridable self-naming for the Pi session and its own tmux window. */
export default function sessionNameExtension(pi: ExtensionAPI): void {
  registerSessionName(pi);
}
