import readline from "node:readline";

const PREFIX = "\u001ePI_WORKFLOW:";
const pending = new Map();
const outstanding = new Set();
let token = "";
let nextId = 0;
let sequencing = Promise.resolve();
let budgetState = { total: null, spent: 0, remaining: null };

function send(message) {
	process.stdout.write(`${PREFIX}${token}:${JSON.stringify(message)}\n`);
}

function updateBudget(message) {
	if (!message || typeof message !== "object" || !message.budget) return;
	budgetState = message.budget;
}

function rpc(method, payload) {
	const id = String(++nextId);
	const request = new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		send({ kind: "request", id, method, payload });
	});
	outstanding.add(request);
	request.then(
		() => outstanding.delete(request),
		() => outstanding.delete(request),
	);
	return request;
}

async function drainOutstanding() {
	while (outstanding.size > 0) await Promise.all([...outstanding]);
}

function enqueueNotification(method, payload) {
	sequencing = sequencing.then(() => rpc(method, payload));
	return sequencing;
}

function errorMessage(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

function makeGlobals(args) {
	const agent = async (prompt, opts = {}) => {
		await sequencing;
		const response = await rpc("agent", { prompt, opts });
		updateBudget(response);
		return response?.value;
	};
	const parallel = async (thunks) => {
		if (!Array.isArray(thunks)) throw new Error("parallel(thunks) requires an array of functions.");
		if (thunks.length > 4096) throw new Error("parallel() accepts at most 4096 thunks.");
		return Promise.all(thunks.map((thunk) => Promise.resolve().then(() => thunk())));
	};
	const pipeline = async (items, ...stages) => {
		if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) requires an array of items.");
		if (items.length > 4096) throw new Error("pipeline() accepts at most 4096 items.");
		return Promise.all(items.map(async (item, index) => {
			let previous = item;
			for (const stage of stages) previous = await stage(previous, item, index);
			return previous;
		}));
	};
	const phase = (title) => { void enqueueNotification("phase", { title: String(title) }); };
	const log = (message) => { void enqueueNotification("log", { message: String(message) }); };
	const workflow = async (nameOrRef, subArgs) => {
		await sequencing;
		const response = await rpc("workflow", { nameOrRef, args: subArgs });
		updateBudget(response);
		return response?.value;
	};
	const budget = Object.freeze({
		get total() { return budgetState.total; },
		spent: () => budgetState.spent,
		remaining: () => budgetState.remaining === null ? Number.POSITIVE_INFINITY : budgetState.remaining,
	});
	return { agent, parallel, pipeline, phase, log, workflow, args, budget };
}

async function execute(init) {
	token = init.token;
	budgetState = init.budget;
	const globals = makeGlobals(init.args);
	const body = init.source.replace(/(^|\n)(\s*)export\s+const\s+meta\s*=/, "$1$2const meta =");
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
	const fn = new AsyncFunction(
		"agent", "parallel", "pipeline", "phase", "log", "workflow", "args", "budget",
		`"use strict";\n${body}\n//# sourceURL=${String(init.fileName || "workflow.js").replace(/[\r\n]/g, "")}`,
	);
	const result = await fn(globals.agent, globals.parallel, globals.pipeline, globals.phase, globals.log, globals.workflow, globals.args, globals.budget);
	await sequencing;
	await drainOutstanding();
	return result;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;
input.on("line", (line) => {
	let message;
	try { message = JSON.parse(line); } catch { return; }
	if (!initialized) {
		initialized = true;
		if (!message || message.kind !== "init" || typeof message.token !== "string" || typeof message.source !== "string") {
			process.exitCode = 1;
			return;
		}
		void execute(message).then(
			(value) => {
				send({ kind: "complete", value });
				setImmediate(() => process.exit(0));
			},
			(error) => {
				send({ kind: "error", error: errorMessage(error), stack: error instanceof Error ? error.stack : undefined });
				setImmediate(() => process.exit(1));
			},
		);
		return;
	}
	if (!message || message.kind !== "response" || message.token !== token || typeof message.id !== "string") return;
	const waiter = pending.get(message.id);
	if (!waiter) return;
	pending.delete(message.id);
	if (message.ok) waiter.resolve(message.result);
	else waiter.reject(new Error(typeof message.error === "string" ? message.error : "Workflow host request failed."));
});

process.on("uncaughtException", (error) => {
	if (token) send({ kind: "error", error: errorMessage(error), stack: error?.stack });
	process.exit(1);
});
process.on("unhandledRejection", (error) => {
	if (token) send({ kind: "error", error: errorMessage(error), stack: error?.stack });
	process.exit(1);
});
