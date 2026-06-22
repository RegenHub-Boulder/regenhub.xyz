/**
 * Dependency-free Markdown → email-ready HTML for LLM-authored newsletters.
 *
 * Covers the subset our authored issues use: #/##/### headings, **bold**,
 * *italic*, [links](url), "- " bullet lists, "---" rules, blank-line
 * paragraphs, emoji passthrough. Every element gets INLINE styles because
 * email clients strip <style> blocks.
 *
 * Authoring is trusted (admin / Claude), so this is not a sanitizer — but raw
 * HTML is escaped so a stray "<" can't break the markup.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Strip a leading YAML frontmatter block (--- ... ---) if present. */
export function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function inline(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, t, u) => `<a href="${u}" style="color:#2d5e3e;text-decoration:underline;">${t}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return out;
}

/**
 * Convert the newsletter Markdown subset into inline-styled HTML (no wrapper).
 *
 * Consecutive non-blank lines are joined into one paragraph / list item (standard
 * Markdown soft-wrap) — so hard-wrapped source doesn't become a pile of tiny
 * <p>s. A blank line ends a block. A trailing backslash forces a hard line break
 * (handy for sign-offs / addresses). Inline spans (bold/italic/links) are applied
 * AFTER joining, so they may span a soft-wrapped line.
 */
export function markdownToEmailHtml(md: string): string {
  const lines = stripFrontmatter(md).split(/\r?\n/);
  const out: string[] = [];
  const BR = "\u0000BR\u0000"; // hard-break sentinel (null bytes) — cannot occur in content, survives HTML-escape, swapped for <br> after inline

  type Seg = { t: string; br: boolean };
  let para: Seg[] = [];
  let items: string[] | null = null;
  let cur: Seg[] | null = null;

  const render = (segs: Seg[]): string => {
    const joined = segs.map((s, i) => s.t + (i < segs.length - 1 ? (s.br ? BR : " ") : "")).join("");
    return inline(joined).split(BR).join("<br>");
  };
  const flushPara = () => { if (para.length) { out.push(`<p style="margin:12px 0;line-height:1.6;">${render(para)}</p>`); para = []; } };
  const flushList = () => {
    if (items) {
      if (cur) { items.push(render(cur)); cur = null; }
      out.push(`<ul style="margin:8px 0;padding-left:20px;line-height:1.6;">${items.map((c) => `<li style="margin:4px 0;">${c}</li>`).join("")}</ul>`);
      items = null;
    }
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (const raw of lines) {
    let t = raw.trim();
    if (!t) { flushAll(); continue; }

    let br = false;
    if (t.endsWith("\\")) { br = true; t = t.replace(/\\+$/, "").trimEnd(); }

    if (/^---+$/.test(t)) { flushAll(); out.push(`<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;" />`); continue; }

    let m: RegExpMatchArray | null;
    if ((m = t.match(/^(#{1,3})\s+(.*)$/))) {
      flushAll();
      const level = m[1].length;
      const style = level === 1 ? "margin:0 0 14px;font-size:24px;"
        : level === 2 ? "margin:26px 0 10px;font-size:20px;"
        : "margin:24px 0 8px;font-size:17px;";
      out.push(`<h${level} style="${style}">${inline(m[2])}</h${level}>`);
      continue;
    }

    if ((m = t.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      if (!items) items = [];
      if (cur) items.push(render(cur));
      cur = [{ t: m[1], br }];
      continue;
    }

    // continuation line: belongs to the open list item, else the open paragraph
    if (cur) cur.push({ t, br });
    else { flushList(); para.push({ t, br }); }
  }
  flushAll();
  return out.join("\n");
}

/**
 * Render a draft's Markdown body into the RegenHub email shell + a per-recipient
 * unsubscribe footer, plus a plain-text alternative.
 */
export function renderDraftEmail(
  markdown: string,
  unsubscribeHref: string,
  archiveHref?: string,
): { html: string; text: string } {
  const body = markdownToEmailHtml(markdown);
  const archiveHtml = archiveHref
    ? `<a href="${archiveHref}" style="color:#999;">Read on the web</a> · `
    : "";
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.55;">
      <p style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#2d5e3e;margin-bottom:12px;">RegenHub dispatch</p>
      ${body}
      <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0 12px;" />
      <p style="font-size:11px;color:#999;">
        ${archiveHtml}You're receiving this because you're part of the RegenHub community —
        maybe you've co-worked with us, joined us on Luma, or signed up at RegenHub.xyz.
        <a href="${unsubscribeHref}" style="color:#999;">Unsubscribe</a> anytime.
      </p>
    </div>`;
  const text = `${stripFrontmatter(markdown).trim()}\n\n—\n${archiveHref ? `Read on the web: ${archiveHref}\n` : ""}Unsubscribe: ${unsubscribeHref}`;
  return { html, text };
}
