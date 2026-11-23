/* seven UI — tiny, dependency-free markdown renderer.
 * Every input is HTML-escaped exactly once, before rendering, so agent/LLM
 * output can never inject markup (no XSS). Supports: fenced code blocks,
 * ATX headings, blockquotes, GFM tables, ul/ol lists, hr, paragraphs with
 * soft <br>, and inline `code`, **bold**, *italic*, ~~strike~~,
 * [links](url), ![images](url).
 * Link/image URLs are restricted to http(s), mailto, and local anchors. */
(function () {
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const NUL = String.fromCharCode(0); // placeholder marker (never matches formatting regexes)

  function safeUrl(url) {
    const u = String(url ?? "")
      .split("")
      .filter((c) => { const n = c.charCodeAt(0); return n > 32 && n !== 127; })
      .join("")
      .trim();
    if (/^(https?|mailto):/i.test(u)) return u;
    if (u.startsWith("#") || u.startsWith("/")) return u;
    return null; // javascript:, data:, vbscript:, … → dropped
  }

  /* Inline formatting. Input must already be HTML-escaped. Generated tags
   * are stashed behind NUL..N placeholders so later regexes never touch
   * their contents. */
  function inline(escaped) {
    const stash = [];
    const keep = (html) => {
      stash.push(html);
      return NUL + (stash.length - 1) + NUL;
    };
    let text = escaped;
    text = text.replace(/`([^`\n]+)`/g, (m, c) => keep("<code>" + c + "</code>"));
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
      const u = safeUrl(url);
      return u ? keep('<img src="' + u + '" alt="' + alt.replace(/\n/g, " ") + '" loading="lazy">') : esc(alt);
    });
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const u = safeUrl(url);
      return u ? keep('<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + label.replace(/\n/g, " ") + "</a>") : label;
    });
    text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    text = text.replace(/(?<![\w*])_([^_\n]+)_(?![\w*])/g, "<em>$1</em>");
    text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    return text.replace(new RegExp(NUL + "(\\d+)" + NUL, "g"), (m, n) => stash[+n]);
  }

  const isDelimRow = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l);
  const splitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");

  function isBlockStart(raw, i) {
    const l = raw[i];
    return (
      /^```/.test(l) ||
      /^#{1,6}\s/.test(l) ||
      /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
      /^\s*>/.test(l) ||
      /^\s*([-*+]|\d+\.)\s+/.test(l) ||
      (l.includes("|") && i + 1 < raw.length && isDelimRow(raw[i + 1]))
    );
  }

  function renderMarkdown(src) {
    const raw = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < raw.length) {
      const line = raw[i];

      let m = line.match(/^```(\w*)\s*$/); // fenced code block
      if (m) {
        const lang = m[1];
        const buf = [];
        i++;
        while (i < raw.length && !/^```\s*$/.test(raw[i])) buf.push(raw[i++]);
        i++; // closing fence (or EOF)
        out.push('<pre class="code"><code' + (lang ? ' class="language-' + esc(lang) + '"' : "") + ">" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }

      m = line.match(/^(#{1,6})\s+(.*)$/); // ATX heading
      if (m) {
        const lvl = m[1].length;
        out.push("<h" + lvl + ">" + inline(esc(m[2].trim())) + "</h" + lvl + ">");
        i++;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

      if (/^\s*>/.test(line)) { // blockquote (recursive on raw lines)
        const buf = [];
        while (i < raw.length && /^\s*>/.test(raw[i])) buf.push(raw[i++].replace(/^\s*>\s?/, ""));
        out.push("<blockquote>" + renderMarkdown(buf.join("\n")) + "</blockquote>");
        continue;
      }

      if (line.includes("|") && i + 1 < raw.length && isDelimRow(raw[i + 1])) { // GFM table
        const aligns = splitRow(raw[i + 1]).map((c) => {
          const t = c.trim();
          if (!/^:?-+:?$/.test(t)) return "";
          if (t.startsWith(":") && t.endsWith(":")) return "center";
          if (t.endsWith(":")) return "right";
          return "left";
        });
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < raw.length && raw[i].trim() !== "" && raw[i].includes("|")) rows.push(splitRow(raw[i++]));
        const cell = (tag, c, k) =>
          "<" + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + inline(esc(c.trim())) + "</" + tag + ">";
        let html = "<table><thead><tr>" + head.map((c, k) => cell("th", c, k)).join("") + "</tr></thead><tbody>";
        for (const r of rows) html += "<tr>" + r.map((c, k) => cell("td", c, k)).join("") + "</tr>";
        out.push(html + "</tbody></table>");
        continue;
      }

      m = line.match(/^\s*([-*+]|\d+\.)\s+/); // list
      if (m) {
        const ordered = /^\d+\./.test(m[1]);
        const tag = ordered ? "ol" : "ul";
        const items = [];
        while (i < raw.length) {
          const m2 = raw[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
          if (!m2) {
            if (items.length && /^\s{2,}\S/.test(raw[i]) && raw[i].trim() !== "") {
              items[items.length - 1] += " " + raw[i].trim(); // continuation line
              i++;
              continue;
            }
            break;
          }
          if (/^\d+\./.test(m2[2]) !== ordered) break; // other list type starts here
          if (items.length && m2[1].length > 0) items[items.length - 1] += " " + m2[3]; // flatten one nesting level
          else items.push(m2[3]);
          i++;
        }
        out.push("<" + tag + ">" + items.map((it) => "<li>" + inline(esc(it)) + "</li>").join("") + "</" + tag + ">");
        continue;
      }

      if (line.trim() === "") { i++; continue; }

      const buf = []; // paragraph
      while (i < raw.length && raw[i].trim() !== "" && !isBlockStart(raw, i)) buf.push(raw[i++]);
      out.push("<p>" + buf.map((l) => inline(esc(l))).join("<br>") + "</p>");
    }
    return out.join("\n");
  }

  window.renderMarkdown = renderMarkdown;
})();
