import { describe, expect, it } from "vitest";
import { markdownToEmailHtml } from "./newsletterMarkdown";

describe("newsletter image lines", () => {
  it("renders an absolute https image as an email-safe block", () => {
    const html = markdownToEmailHtml("Before\n\n![Lookout](https://regenhub.xyz/newsletter/a.jpg)\n\nAfter");
    expect(html).toContain(
      '<img src="https://regenhub.xyz/newsletter/a.jpg" alt="Lookout" width="100%" style="display:block;max-width:600px;width:100%;height:auto;border-radius:8px;margin:16px 0;">',
    );
    expect(html).toContain("<p");
  });

  it("ends the open paragraph when an image follows without a blank line", () => {
    const html = markdownToEmailHtml("Text\n![a](https://x.test/a.jpg)");
    expect(html).toBe(
      '<p style="margin:12px 0;line-height:1.6;">Text</p>\n<img src="https://x.test/a.jpg" alt="a" width="100%" style="display:block;max-width:600px;width:100%;height:auto;border-radius:8px;margin:16px 0;">',
    );
  });

  it.each([
    "![x](/newsletter/a.jpg)",
    "![x](http://x.test/a.jpg)",
    "![x](javascript:alert(1))",
    "![x](data:image/png;base64,AAAA)",
    "![x](//x.test/a.jpg)",
  ])("leaves %s as text, with no <img>", (line) => {
    expect(markdownToEmailHtml(line)).not.toContain("<img");
  });

  it("escapes alt text", () => {
    const html = markdownToEmailHtml('![a "q" <b>&](https://x.test/a.jpg)');
    expect(html).toContain('alt="a &quot;q&quot; &lt;b&gt;&amp;"');
    expect(html).not.toContain("<b>");
  });

  it("does not let a quote in the URL break out of src", () => {
    const html = markdownToEmailHtml('![a](https://x.test/a.jpg"onerror="x)');
    expect(html).not.toContain("<img");
  });
});
