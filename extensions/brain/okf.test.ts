import { describe, expect, it } from "bun:test";
import {
	conceptIdFromPath,
	isConceptFile,
	type OkfDoc,
	parseOkf,
	pathFromConceptId,
	slugify,
	stringifyOkf,
} from "./okf";

describe("parseOkf", () => {
	it("splits frontmatter from body", () => {
		const doc = parseOkf(
			"---\ntype: Note\ntitle: Hello\n---\n\n# Body\n\nText here.\n",
		);
		expect(doc.frontmatter.type).toBe("Note");
		expect(doc.frontmatter.title).toBe("Hello");
		expect(doc.body).toBe("# Body\n\nText here.\n");
	});

	it("treats a file with no frontmatter as a bodied doc with empty frontmatter", () => {
		const doc = parseOkf("# Just markdown\n\nNo frontmatter.\n");
		expect(doc.frontmatter).toEqual({});
		expect(doc.body).toBe("# Just markdown\n\nNo frontmatter.\n");
	});

	it("parses tags as a list and preserves unknown extension keys", () => {
		const doc = parseOkf(
			"---\ntype: Decision\ntags: [autonomy, brain]\nconfidence: VERIFIED\nactor: tom\n---\nbody\n",
		);
		expect(doc.frontmatter.tags).toEqual(["autonomy", "brain"]);
		expect(doc.frontmatter.confidence).toBe("VERIFIED");
		expect(doc.frontmatter.actor).toBe("tom");
	});

	it("handles an empty body after frontmatter", () => {
		const doc = parseOkf("---\ntype: Note\n---\n");
		expect(doc.frontmatter.type).toBe("Note");
		expect(doc.body).toBe("");
	});

	it("does not throw on malformed frontmatter", () => {
		const text = "---\n: : : not yaml\n---\nbody\n";
		expect(() => parseOkf(text)).not.toThrow();
	});

	it("tolerates CRLF line endings", () => {
		const doc = parseOkf("---\r\ntype: Note\r\n---\r\nbody\r\n");
		expect(doc.frontmatter.type).toBe("Note");
		expect(doc.body.trim()).toBe("body");
	});
});

describe("stringifyOkf", () => {
	it("emits canonical keys first, then extension keys alphabetically", () => {
		const doc: OkfDoc = {
			frontmatter: {
				zeta: 1,
				type: "Note",
				actor: "tom",
				title: "T",
				description: "d",
			},
			body: "hello",
		};
		const out = stringifyOkf(doc);
		const order = ["type", "title", "description", "actor", "zeta"];
		const positions = order.map((k) => out.indexOf(`${k}:`));
		const sorted = [...positions].sort((a, b) => a - b);
		expect(positions).toEqual(sorted);
		expect(positions.every((p) => p > 0)).toBe(true);
	});

	it("round-trips frontmatter and body semantically", () => {
		const original: OkfDoc = {
			frontmatter: {
				type: "Project",
				title: "Agent Toolkit",
				description: "Autonomous personal agent.",
				tags: ["meta", "pi"],
				timestamp: "2026-06-24T10:00:00Z",
				custom: "kept",
			},
			body: "# Notes\n\n- one\n- two",
		};
		const reparsed = parseOkf(stringifyOkf(original));
		expect(reparsed.frontmatter).toEqual(original.frontmatter);
		expect(reparsed.body.trim()).toBe(original.body.trim());
	});

	it("normalises the body to a single trailing newline", () => {
		const out = stringifyOkf({ frontmatter: { type: "Note" }, body: "x\n\n\n" });
		expect(out.endsWith("x\n")).toBe(true);
		expect(out.endsWith("x\n\n")).toBe(false);
	});

	it("omits undefined values", () => {
		const out = stringifyOkf({
			frontmatter: { type: "Note", title: undefined },
			body: "b",
		});
		expect(out.includes("title")).toBe(false);
	});
});

describe("concept id <-> path", () => {
	it("strips the .md suffix and normalises slashes", () => {
		expect(conceptIdFromPath("people/tom.md")).toBe("people/tom");
		expect(conceptIdFromPath("./projects/x.md")).toBe("projects/x");
		expect(conceptIdFromPath("a\\b.md")).toBe("a/b");
	});

	it("is invertible", () => {
		expect(pathFromConceptId("people/tom")).toBe("people/tom.md");
		expect(pathFromConceptId("people/tom.md")).toBe("people/tom.md");
	});
});

describe("isConceptFile", () => {
	it("accepts .md files that are not reserved", () => {
		expect(isConceptFile("tom.md")).toBe(true);
		expect(isConceptFile("people/tom.md")).toBe(true);
	});

	it("rejects reserved filenames and non-markdown", () => {
		expect(isConceptFile("index.md")).toBe(false);
		expect(isConceptFile("log.md")).toBe(false);
		expect(isConceptFile("people/index.md")).toBe(false);
		expect(isConceptFile("notes.txt")).toBe(false);
	});
});

describe("slugify", () => {
	it("lowercases, hyphenates, and strips punctuation", () => {
		expect(slugify("Fix login cache!")).toBe("fix-login-cache");
		expect(slugify("  Trailing/leading  ")).toBe("trailing-leading");
	});

	it("transliterates diacritics", () => {
		expect(slugify("Café Déjà")).toBe("cafe-deja");
	});

	it("falls back to 'untitled' for empty/symbol-only input", () => {
		expect(slugify("")).toBe("untitled");
		expect(slugify("!!!")).toBe("untitled");
	});

	it("bounds length without a trailing hyphen", () => {
		const out = slugify("a".repeat(100), 10);
		expect(out.length).toBeLessThanOrEqual(10);
		expect(out.endsWith("-")).toBe(false);
	});
});
