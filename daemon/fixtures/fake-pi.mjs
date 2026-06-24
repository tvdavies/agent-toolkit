// Minimal fake `pi --mode rpc` for daemon tests. Speaks just enough of the RPC
// protocol (docs/rpc.md) to exercise RpcClient/Supervisor without a real model.
//
// Behaviour:
//   prompt "<text>"  -> log the text, stream a tiny response, emit agent_end
//   prompt "EXIT"    -> log, then exit(1)  (to test respawn)
//   prompt "ASKUI"   -> emit a confirm dialog; log the client's UI response
//   extension_ui_response -> log "UIRESP <cancelled|confirmed:...>"
//   abort            -> respond success
//
// Set FAKE_PI_LOG to a writable path to capture what the daemon delivered.

import { appendFileSync } from "node:fs";

const LOG = process.env.FAKE_PI_LOG;
const log = (line) => {
	if (LOG) appendFileSync(LOG, `${line}\n`);
};
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function runPrompt(message) {
	log(`PROMPT ${message}`);
	if (message === "EXIT") process.exit(1);
	send({ type: "agent_start" });
	send({
		type: "message_update",
		message: {},
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" },
	});
	if (message === "ASKUI") {
		send({ type: "extension_ui_request", id: "u1", method: "confirm", title: "t", message: "m" });
		// agent_end is emitted after the UI response arrives (see handle()).
		return;
	}
	send({ type: "turn_end", message: {}, toolResults: [] });
	send({ type: "agent_end", messages: [] });
	send({ type: "response", command: "prompt", success: true });
}

function handle(cmd) {
	switch (cmd.type) {
		case "prompt":
			runPrompt(String(cmd.message ?? ""));
			return;
		case "extension_ui_response":
			log(`UIRESP ${cmd.cancelled ? "cancelled" : `confirmed:${cmd.confirmed}`}`);
			send({ type: "turn_end", message: {}, toolResults: [] });
			send({ type: "agent_end", messages: [] });
			return;
		case "abort":
			send({ type: "response", command: "abort", success: true });
			return;
		case "get_session_stats":
			send({
				type: "response",
				command: "get_session_stats",
				id: cmd.id,
				success: true,
				data: { cost: Number(process.env.FAKE_PI_COST ?? 0) },
			});
			return;
		default:
			send({ type: "response", command: cmd.type ?? "unknown", success: true });
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index !== -1) {
		let line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line !== "") {
			try {
				handle(JSON.parse(line));
			} catch {
				// ignore malformed input
			}
		}
		index = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
