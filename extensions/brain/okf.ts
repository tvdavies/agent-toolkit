/**
 * Open Knowledge Format (OKF) — pure parse/serialise core.
 *
 * OKF (https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
 * represents knowledge as plain markdown files with YAML frontmatter, organised
 * in a directory hierarchy. A "concept" is one markdown document; its id is the
 * file path within the bundle with the `.md` suffix removed. `index.md` and
 * `log.md` are reserved filenames.
 *
 * This module is deliberately free of any Pi or Node-fs dependency so it can be
 * unit-tested directly with `bun test`. It owns only the document grammar:
 * frontmatter <-> object, concept-id <-> path, and slugging.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Reserved filenames with defined meaning at any level of the hierarchy. */
export const RESERVED_FILENAMES = ["index.md", "log.md"] as const;

/**
 * OKF frontmatter. Only `type` is required by the spec, but readers must
 * tolerate its absence (we default it when writing). Producers may add
 * arbitrary extra keys; consumers must preserve unknown keys on round-trip.
 */
export type OkfFrontmatter = {
	/** REQUIRED by the spec. Short string identifying the kind of concept. */
	type?: string;
	/** Human-readable display name. */
	title?: string;
	/** One-line summary used in indexes, snippets, and previews. */
	description?: string;
	/** Canonical URI for the underlying asset, if the concept describes one. */
	resource?: string;
	/** Cross-cutting categorisation. */
	tags?: string[];
	/** ISO 8601 datetime of last meaningful change. */
	timestamp?: string;
	/** Producer-defined extension keys (e.g. source, confidence, actor). */
	[key: string]: unknown;
};

/** A parsed concept document: frontmatter plus the markdown body after it. */
export type OkfDoc = {
	frontmatter: OkfFrontmatter;
	body: string;
};

/** Canonical frontmatter key order; extension keys follow, alphabetically. */
const CANONICAL_KEYS: readonly (keyof OkfFrontmatter)[] = [
	"type",
	"title",
	"description",
	"resource",
	"tags",
	"timestamp",
];

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a concept document into frontmatter and body. A file with no leading
 * frontmatter block is treated as a bodied document with empty frontmatter,
 * rather than rejected — readers must be lenient.
 */
export function parseOkf(text: string): OkfDoc {
	const match = FRONTMATTER_RE.exec(text);
	if (!match) {
		return { frontmatter: {}, body: text.replace(/^\r?\n/, "") };
	}
	const yamlText = match[1] ?? "";
	// Strip the single conventional blank-line separator so parse is the exact
	// inverse of stringifyOkf (which writes `---\n\n<body>`).
	const body = text.slice(match[0].length).replace(/^\r?\n/, "");
	let parsed: unknown;
	try {
		parsed = yamlText.trim() === "" ? {} : parseYaml(yamlText);
	} catch {
		// Malformed frontmatter: keep the raw text addressable rather than throw.
		return { frontmatter: {}, body: text };
	}
	const frontmatter =
		parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as OkfFrontmatter)
			: {};
	return { frontmatter, body };
}

/**
 * Serialise a concept document back to OKF text. Frontmatter keys are emitted
 * in canonical order (type, title, …) followed by any extension keys sorted
 * alphabetically, so writes are deterministic and diff-friendly. The body is
 * normalised to exactly one trailing newline.
 */
export function stringifyOkf(doc: OkfDoc): string {
	const ordered = orderFrontmatter(doc.frontmatter);
	const yamlText = stringifyYaml(ordered, { lineWidth: 0 }).trimEnd();
	const body = doc.body.replace(/\s+$/, "");
	const front = `---\n${yamlText}\n---\n`;
	return body === "" ? front : `${front}\n${body}\n`;
}

/** Build canonical-then-alphabetical key order, dropping undefined values. */
function orderFrontmatter(fm: OkfFrontmatter): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of CANONICAL_KEYS) {
		const value = fm[key];
		if (value !== undefined) out[key] = value;
	}
	for (const key of Object.keys(fm).sort()) {
		if (CANONICAL_KEYS.includes(key as keyof OkfFrontmatter)) continue;
		if (fm[key] !== undefined) out[key] = fm[key];
	}
	return out;
}

/** Concept id = bundle-relative path with the `.md` suffix removed, POSIX-slashed. */
export function conceptIdFromPath(relativePath: string): string {
	return relativePath
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/\.md$/i, "");
}

/** Inverse of {@link conceptIdFromPath}. */
export function pathFromConceptId(conceptId: string): string {
	return `${conceptId.replace(/\.md$/i, "")}.md`;
}

/** A `.md` file that is not a reserved filename is a concept document. */
export function isConceptFile(filename: string): boolean {
	const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
	if (!base.toLowerCase().endsWith(".md")) return false;
	return !RESERVED_FILENAMES.includes(
		base.toLowerCase() as (typeof RESERVED_FILENAMES)[number],
	);
}

/**
 * Slugify free text into a safe, stable filename stem: lowercase, ASCII,
 * hyphen-separated, bounded length. Returns "untitled" for empty input.
 */
export function slugify(input: string, maxLength = 60): string {
	const slug = input
		.normalize("NFKD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength)
		.replace(/-+$/g, "");
	return slug || "untitled";
}
