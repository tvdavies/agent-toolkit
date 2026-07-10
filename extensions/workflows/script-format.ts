/** Safe parsing and lexical validation for workflow JavaScript sources.
 *
 * The parser intentionally accepts only the small literal grammar documented for
 * `export const meta = { ... }`. It never evaluates source code. Workflow bodies
 * execute only in the out-of-process sandbox (sandbox.ts).
 */

export interface WorkflowMeta {
	/** Version 2 enables fail-fast child semantics. Omitted means legacy nullable failures. */
	version?: number;
	name: string;
	description?: string;
	whenToUse?: string;
	model?: string;
	phases?: Array<{ title: string; detail?: string; model?: string }>;
	dependencies?: string[];
}

// Blank out string/template/comment contents (preserving length) so pattern checks and
// brace matching only see real code, not prompt text that may contain forbidden words.
export function stripStringsAndComments(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (c === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") { out += " "; i++; }
			continue;
		}
		if (c === "/" && next === "*") {
			out += "  "; i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
				out += src[i] === "\n" ? "\n" : " ";
				i++;
			}
			if (i < src.length) { out += "  "; i += 2; }
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			out += " "; i++;
			while (i < src.length) {
				if (src[i] === "\\") { out += "  "; i += 2; continue; }
				if (src[i] === quote) { out += " "; i++; break; }
				out += src[i] === "\n" ? "\n" : " "; i++;
			}
			continue;
		}
		out += c; i++;
	}
	return out;
}

function findMatchingBrace(src: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

class LiteralParser {
	private i = 0;
	constructor(private readonly source: string) {}

	parse(): unknown {
		const value = this.value();
		this.ws();
		if (this.i !== this.source.length) this.fail("unexpected trailing input");
		return value;
	}

	private fail(message: string): never {
		throw new Error(`meta must be a pure object literal (${message} at offset ${this.i})`);
	}

	private ws(): void {
		while (/\s/.test(this.source[this.i] ?? "")) this.i++;
	}

	private value(): unknown {
		this.ws();
		const c = this.source[this.i];
		if (c === "{") return this.object();
		if (c === "[") return this.array();
		if (c === '"' || c === "'" || c === "`") return this.string();
		if (c === "-" || /[0-9]/.test(c ?? "")) return this.number();
		const word = this.identifier();
		if (word === "true") return true;
		if (word === "false") return false;
		if (word === "null") return null;
		this.fail(`expressions and identifier values are not allowed: ${word || "unknown token"}`);
	}

	private object(): Record<string, unknown> {
		const result: Record<string, unknown> = Object.create(null);
		this.i++;
		this.ws();
		if (this.source[this.i] === "}") { this.i++; return result; }
		while (this.i < this.source.length) {
			this.ws();
			const c = this.source[this.i];
			if (c === "." || c === "[" || c === "*") this.fail("spreads, computed keys, and methods are not allowed");
			const key = c === '"' || c === "'" || c === "`" ? this.string() : this.identifier();
			if (!key) this.fail("expected an object key");
			if (key === "__proto__" || key === "prototype" || key === "constructor") this.fail(`forbidden object key: ${key}`);
			this.ws();
			if (this.source[this.i] !== ":") this.fail("expected ':' after object key");
			this.i++;
			if (Object.prototype.hasOwnProperty.call(result, key)) this.fail(`duplicate object key: ${key}`);
			result[key] = this.value();
			this.ws();
			if (this.source[this.i] === "}") { this.i++; return result; }
			if (this.source[this.i] !== ",") this.fail("expected ',' or '}'");
			this.i++;
			this.ws();
			if (this.source[this.i] === "}") { this.i++; return result; }
		}
		this.fail("unterminated object");
	}

	private array(): unknown[] {
		const result: unknown[] = [];
		this.i++;
		this.ws();
		if (this.source[this.i] === "]") { this.i++; return result; }
		while (this.i < this.source.length) {
			result.push(this.value());
			this.ws();
			if (this.source[this.i] === "]") { this.i++; return result; }
			if (this.source[this.i] !== ",") this.fail("expected ',' or ']'");
			this.i++;
			this.ws();
			if (this.source[this.i] === "]") { this.i++; return result; }
		}
		this.fail("unterminated array");
	}

	private identifier(): string {
		this.ws();
		const start = this.i;
		if (!/[A-Za-z_$]/.test(this.source[this.i] ?? "")) return "";
		this.i++;
		while (/[A-Za-z0-9_$-]/.test(this.source[this.i] ?? "")) this.i++;
		return this.source.slice(start, this.i);
	}

	private number(): number {
		const rest = this.source.slice(this.i);
		const match = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
		if (!match) this.fail("invalid number");
		this.i += match[0].length;
		const value = Number(match[0]);
		if (!Number.isFinite(value)) this.fail("numbers must be finite");
		return value;
	}

	private string(): string {
		const quote = this.source[this.i++];
		let out = "";
		while (this.i < this.source.length) {
			const c = this.source[this.i++];
			if (c === quote) return out;
			if (quote === "`" && c === "$" && this.source[this.i] === "{") this.fail("template interpolation is not allowed");
			if (c === "\n" || c === "\r") this.fail("literal newlines are not allowed in meta strings");
			if (c !== "\\") { out += c; continue; }
			if (this.i >= this.source.length) this.fail("unterminated string escape");
			const escaped = this.source[this.i++];
			switch (escaped) {
				case "n": out += "\n"; break;
				case "r": out += "\r"; break;
				case "t": out += "\t"; break;
				case "b": out += "\b"; break;
				case "f": out += "\f"; break;
				case "v": out += "\v"; break;
				case "0": out += "\0"; break;
				case "\\": case '"': case "'": case "`": out += escaped; break;
				case "u": {
					const hex = this.source.slice(this.i, this.i + 4);
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid unicode escape");
					out += String.fromCharCode(Number.parseInt(hex, 16));
					this.i += 4;
					break;
				}
				default: out += escaped;
			}
		}
		this.fail("unterminated string");
	}
}

function assertMeta(value: unknown): WorkflowMeta {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("meta must be an object literal.");
	const meta = value as Record<string, unknown>;
	if (typeof meta.name !== "string" || !meta.name.trim()) throw new Error("`meta.name` is required and must be a non-empty string.");
	if (meta.version !== undefined && meta.version !== 2) throw new Error("meta.version must be 2 when provided.");
	for (const key of ["description", "whenToUse", "model"] as const) {
		if (meta[key] !== undefined && typeof meta[key] !== "string") throw new Error(`meta.${key} must be a string when provided.`);
	}
	if (meta.dependencies !== undefined && (!Array.isArray(meta.dependencies) || meta.dependencies.some((item) => typeof item !== "string" || !item.trim()))) {
		throw new Error("meta.dependencies must be an array of non-empty saved workflow names.");
	}
	if (meta.phases !== undefined) {
		if (!Array.isArray(meta.phases)) throw new Error("meta.phases must be an array.");
		for (const phase of meta.phases) {
			if (!phase || typeof phase !== "object" || Array.isArray(phase) || typeof (phase as Record<string, unknown>).title !== "string") {
				throw new Error("Each meta phase must be an object with a string title.");
			}
		}
	}
	return value as WorkflowMeta;
}

export function extractMeta(source: string): WorkflowMeta {
	const stripped = stripStringsAndComments(source);
	const match = stripped.match(/export\s+const\s+meta\s*=\s*/);
	if (!match || match.index === undefined) throw new Error("Workflow must define `export const meta = { name, description }`.");
	const braceStart = stripped.indexOf("{", match.index + match[0].length);
	if (braceStart === -1) throw new Error("`meta` must be an object literal.");
	const braceEnd = findMatchingBrace(stripped, braceStart);
	if (braceEnd === -1) throw new Error("Unterminated `meta` object literal.");
	const between = stripped.slice(match.index + match[0].length, braceStart);
	if (between.trim()) throw new Error("`meta` must be a direct object literal.");
	return assertMeta(new LiteralParser(source.slice(braceStart, braceEnd + 1)).parse());
}

export function validateScript(source: string): string[] {
	const errors: string[] = [];
	const code = stripStringsAndComments(source);
	if (/(^|\n)\s*import\b/.test(code)) errors.push("Workflow scripts must not import anything; use the injected globals.");
	if (/(^|\n)\s*export\s+(?!const\s+meta\b)/.test(code)) errors.push("Only `export const meta` is allowed.");
	const forbidden = [
		/\brequire\s*\(/,
		/\bprocess\b/,
		/\bDate\.now\s*\(/,
		/\bMath\.random\s*\(/,
		/\bnew\s+Date\s*\(\s*\)/,
		/\beval\s*\(/,
		/\bFunction\s*\(/,
		/\bimport\s*\(/,
		/\.constructor\b/,
		/\b__proto__\b/,
	];
	for (const re of forbidden) if (re.test(code)) errors.push(`Forbidden pattern (non-deterministic or unsafe): ${re}`);
	if (!/export\s+const\s+meta\s*=/.test(code)) errors.push("Workflow must define `export const meta = { name, description }`.");
	try { extractMeta(source); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
	return [...new Set(errors)];
}
