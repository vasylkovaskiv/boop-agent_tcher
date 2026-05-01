// Convert "natural" markdown (as LLMs produce) into Telegram MarkdownV2.
//
// Telegram MarkdownV2 requires escaping these characters outside of markup:
//   _ * [ ] ( ) ~ ` > # + - = | { } . !
//
// The approach: first protect recognized markdown constructs (bold, italic,
// code, links, strikethrough), escape everything else, then restore the
// constructs using MarkdownV2 syntax.
//
// This is intentionally best-effort — LLM output is unpredictable. If
// sendMessage rejects the result, the caller falls back to plain text.

const ESCAPE_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/** Escape a plain-text string for MarkdownV2. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(ESCAPE_CHARS, "\\$1");
}

interface Token {
  type: "text" | "bold" | "italic" | "code" | "code_block" | "strike" | "link" | "heading";
  raw: string;
  /** For links: the URL part */
  url?: string;
  /** For links / bold / italic / strike: the inner text */
  inner?: string;
  /** For code_block: optional language */
  lang?: string;
}

/**
 * Tokenise LLM-style markdown into a flat list of typed segments.
 * Recognised constructs:
 *   **bold**  or  __bold__
 *   *italic*  or  _italic_
 *   ~~strike~~
 *   `inline code`
 *   ```lang\ncode\n```
 *   [text](url)
 *   # / ## / ### headings (converted to bold)
 */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let buf = "";

  const flush = () => {
    if (buf) {
      tokens.push({ type: "text", raw: buf });
      buf = "";
    }
  };

  while (i < src.length) {
    // Code block: ```
    if (src.startsWith("```", i)) {
      flush();
      const afterTicks = i + 3;
      const closeIdx = src.indexOf("```", afterTicks);
      if (closeIdx !== -1) {
        const block = src.slice(afterTicks, closeIdx);
        const nlIdx = block.indexOf("\n");
        const lang = nlIdx > 0 ? block.slice(0, nlIdx).trim() : "";
        const code = nlIdx > 0 ? block.slice(nlIdx + 1) : block;
        tokens.push({ type: "code_block", raw: src.slice(i, closeIdx + 3), inner: code, lang });
        i = closeIdx + 3;
        continue;
      }
    }

    // Inline code: `...`
    if (src[i] === "`" && src[i + 1] !== "`") {
      const closeIdx = src.indexOf("`", i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1) {
        flush();
        const code = src.slice(i + 1, closeIdx);
        tokens.push({ type: "code", raw: src.slice(i, closeIdx + 1), inner: code });
        i = closeIdx + 1;
        continue;
      }
    }

    // Link: [text](url)
    if (src[i] === "[") {
      const closeBracket = src.indexOf("](", i);
      if (closeBracket !== -1) {
        const closeParen = src.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          flush();
          const text = src.slice(i + 1, closeBracket);
          const url = src.slice(closeBracket + 2, closeParen);
          tokens.push({ type: "link", raw: src.slice(i, closeParen + 1), inner: text, url });
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Bold: **text** (must check before single *)
    if (src.startsWith("**", i)) {
      const closeIdx = src.indexOf("**", i + 2);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        flush();
        const inner = src.slice(i + 2, closeIdx);
        tokens.push({ type: "bold", raw: src.slice(i, closeIdx + 2), inner });
        i = closeIdx + 2;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (src.startsWith("~~", i)) {
      const closeIdx = src.indexOf("~~", i + 2);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        flush();
        const inner = src.slice(i + 2, closeIdx);
        tokens.push({ type: "strike", raw: src.slice(i, closeIdx + 2), inner });
        i = closeIdx + 2;
        continue;
      }
    }

    // Italic: *text* (single star, not followed by another star)
    if (src[i] === "*" && src[i + 1] !== "*") {
      const closeIdx = src.indexOf("*", i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1 && src[closeIdx + 1] !== "*") {
        flush();
        const inner = src.slice(i + 1, closeIdx);
        tokens.push({ type: "italic", raw: src.slice(i, closeIdx + 1), inner });
        i = closeIdx + 1;
        continue;
      }
    }

    // Heading: # at start of line → bold
    if ((i === 0 || src[i - 1] === "\n") && src[i] === "#") {
      let h = i;
      while (src[h] === "#") h++;
      if (src[h] === " ") {
        flush();
        const eol = src.indexOf("\n", h);
        const end = eol === -1 ? src.length : eol;
        const inner = src.slice(h + 1, end);
        tokens.push({ type: "heading", raw: src.slice(i, end), inner });
        i = end;
        continue;
      }
    }

    buf += src[i];
    i++;
  }
  flush();
  return tokens;
}

/**
 * Convert LLM markdown to Telegram MarkdownV2.
 * Returns the formatted string ready for `parse_mode: "MarkdownV2"`.
 */
export function toMarkdownV2(src: string): string {
  const tokens = tokenize(src);
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        out += escapeMarkdownV2(t.raw);
        break;
      case "bold":
        out += `*${escapeMarkdownV2(t.inner!)}*`;
        break;
      case "italic":
        out += `_${escapeMarkdownV2(t.inner!)}_`;
        break;
      case "strike":
        out += `~${escapeMarkdownV2(t.inner!)}~`;
        break;
      case "code":
        // Inside inline code, only ` and \ need escaping.
        out += "`" + t.inner!.replace(/([`\\])/g, "\\$1") + "`";
        break;
      case "code_block":
        // Inside code blocks, only ``` needs escaping; content is literal.
        out += "```" + (t.lang ?? "") + "\n" + t.inner! + "```";
        break;
      case "link":
        // MarkdownV2 link: [escaped text](url) — URL needs escaping of ) and \
        out += `[${escapeMarkdownV2(t.inner!)}](${t.url!.replace(/([)\\])/g, "\\$1")})`;
        break;
      case "heading":
        // Headings → bold text + newline
        out += `*${escapeMarkdownV2(t.inner!)}*`;
        break;
    }
  }
  return out;
}
