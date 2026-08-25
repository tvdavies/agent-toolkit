#!/usr/bin/env python3
"""Convert lightly-marked-up text into Slack rich_text blocks.

Slack has no plain-text list syntax: "- ", "* " and a literal "•" all post as
raw characters inside a paragraph. A real list has to be a rich_text block
containing a rich_text_list element. This turns "- " / "1. " lines into that
structure.

Blocks bypass mrkdwn parsing entirely, so inline markup (code, links, mentions,
emoji, bold, italic) has to be re-encoded as rich_text elements too, or it would
render literally once a message switches to blocks.

Reads message text on stdin, writes {"text": <fallback>, "blocks": <array|null>}.
blocks is null when the text contains no list, so ordinary messages keep going
out as plain text and keep Slack's own mrkdwn parsing.
"""

import json
import re
import sys

LIST_RE = re.compile(
    r"^(?P<indent>[ \t]*)"
    r"(?:(?P<bullet>[-*•])|(?P<num>\d+)[.)])"
    r"[ \t]+(?P<content>.*\S)[ \t]*$"
)

# Ordered by precedence. Code wins so nothing is reinterpreted inside a span.
# Bold/italic require word boundaries, otherwise snake_case identifiers like
# send_user_message would come out italicised (Slack's mrkdwn leaves them alone).
INLINE_RE = re.compile(
    r"`(?P<code>[^`\n]+)`"
    r"|<(?P<link_url>(?:https?|mailto):[^>|]+)\|(?P<link_text>[^>]+)>"
    r"|<(?P<bare_link>(?:https?|mailto):[^>|]+)>"
    r"|<@(?P<user>[UW][A-Z0-9]+)(?:\|[^>]*)?>"
    r"|<#(?P<channel>[CG][A-Z0-9]+)(?:\|[^>]*)?>"
    r"|<!(?P<broadcast>here|channel|everyone)(?:\|[^>]*)?>"
    r"|(?P<url>https?://[^\s<>|`]+)"
    r"|(?<!\w):(?P<emoji>[a-z][a-z0-9_+'-]*):"
    r"|(?<![\w*])\*(?P<bold>[^\s*][^*]*?)\*(?![\w*])"
    r"|(?<![\w_])_(?P<italic>[^\s_][^_]*?)_(?![\w_])"
)

URL_TRAILING = ".,;:!?)]}'\""
MAX_INDENT = 8


def inline_elements(text):
    """Tokenise a run of text into rich_text inline elements."""
    elements = []
    pos = 0

    def push_text(fragment):
        if not fragment:
            return
        if elements and elements[-1].get("type") == "text" and "style" not in elements[-1]:
            elements[-1]["text"] += fragment
        else:
            elements.append({"type": "text", "text": fragment})

    for match in INLINE_RE.finditer(text):
        push_text(text[pos : match.start()])
        pos = match.end()

        if match.group("code") is not None:
            elements.append(
                {"type": "text", "text": match.group("code"), "style": {"code": True}}
            )
        elif match.group("link_url"):
            elements.append(
                {
                    "type": "link",
                    "url": match.group("link_url"),
                    "text": match.group("link_text"),
                }
            )
        elif match.group("bare_link"):
            elements.append({"type": "link", "url": match.group("bare_link")})
        elif match.group("user"):
            elements.append({"type": "user", "user_id": match.group("user")})
        elif match.group("channel"):
            elements.append({"type": "channel", "channel_id": match.group("channel")})
        elif match.group("broadcast"):
            elements.append({"type": "broadcast", "range": match.group("broadcast")})
        elif match.group("url"):
            url = match.group("url")
            trailing = ""
            while url and url[-1] in URL_TRAILING:
                trailing = url[-1] + trailing
                url = url[:-1]
            elements.append({"type": "link", "url": url})
            push_text(trailing)
        elif match.group("emoji"):
            elements.append({"type": "emoji", "name": match.group("emoji")})
        elif match.group("bold"):
            elements.append(
                {"type": "text", "text": match.group("bold"), "style": {"bold": True}}
            )
        elif match.group("italic"):
            elements.append(
                {"type": "text", "text": match.group("italic"), "style": {"italic": True}}
            )

    push_text(text[pos:])
    return elements


def parse_nodes(text):
    """Split the message into alternating text runs and list runs."""
    nodes = []
    buffer = []

    for line in text.split("\n"):
        match = LIST_RE.match(line)
        if not match:
            buffer.append(line)
            continue

        if buffer:
            nodes.append(("text", buffer))
            buffer = []

        style = "bullet" if match.group("bullet") else "ordered"
        indent = min(
            len(match.group("indent").replace("\t", "  ")) // 2, MAX_INDENT
        )
        content = match.group("content")

        if (
            nodes
            and nodes[-1][0] == "list"
            and nodes[-1][1] == style
            and nodes[-1][2] == indent
        ):
            nodes[-1][3].append(content)
        else:
            nodes.append(["list", style, indent, [content]])

    while buffer and not buffer[-1].strip():
        buffer.pop()
    if buffer:
        nodes.append(("text", buffer))

    return nodes


def build_blocks(nodes):
    """Render nodes as a single rich_text block.

    A text run adjacent to a list gains one newline on that side. That is what
    Slack's own editor emits, and it is what gives the list correct vertical
    spacing: no blank line, but not flush against the paragraph either.
    """
    elements = []

    for index, node in enumerate(nodes):
        if node[0] == "text":
            body = "\n".join(node[1])
            if index > 0 and nodes[index - 1][0] == "list":
                body = "\n" + body
            if index + 1 < len(nodes) and nodes[index + 1][0] == "list":
                body = body + "\n"
            if not body:
                continue
            elements.append(
                {"type": "rich_text_section", "elements": inline_elements(body)}
            )
        else:
            _, style, indent, items = node
            elements.append(
                {
                    "type": "rich_text_list",
                    "style": style,
                    "indent": indent,
                    "border": 0,
                    "elements": [
                        {"type": "rich_text_section", "elements": inline_elements(item)}
                        for item in items
                    ],
                }
            )

    return [{"type": "rich_text", "elements": elements}]


def build_fallback(text):
    """Plain-text version used for notifications, matching Slack's own rendering."""
    lines = []
    for line in text.split("\n"):
        match = LIST_RE.match(line)
        if not match:
            lines.append(line)
        elif match.group("bullet"):
            lines.append("• " + match.group("content"))
        else:
            lines.append(f"{match.group('num')}. {match.group('content')}")
    return "\n".join(lines)


def main():
    text = sys.stdin.read().rstrip("\n")
    if not text.strip():
        print(json.dumps({"text": text, "blocks": None}))
        return

    nodes = parse_nodes(text)
    has_list = any(node[0] == "list" for node in nodes)

    payload = {
        "text": build_fallback(text) if has_list else text,
        "blocks": build_blocks(nodes) if has_list else None,
    }
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
