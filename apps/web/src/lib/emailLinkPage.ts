/**
 * The small page an email link lands on (newsletter unsubscribe, "no more notes after nights"): a title, a line, and
 * optionally one button that posts back to the same URL. Inline HTML, no app chrome, so it works from any mail app.
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function emailLinkPage(
  title: string,
  body: string,
  ok: boolean,
  confirm?: { label: string; action: string },
): Response {
  const button = confirm
    ? `<form method="post" action="${esc(confirm.action)}" style="margin-top: 24px;"><button type="submit" style="font: inherit; font-size: 15px; padding: 10px 20px; border-radius: 8px; border: 0; background: #7fb069; color: #0e1410; cursor: pointer;">${esc(confirm.label)}</button></form>`
    : "";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
       <title>${esc(title)} — RegenHub</title></head>
       <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0e1410; color: #e8ece9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0;">
         <div style="max-width: 420px; padding: 40px; text-align: center;">
           <h1 style="color: ${ok ? "#7fb069" : "#e07a5f"}; font-size: 22px;">${esc(title)}</h1>
           <p style="color: #a8b0aa; line-height: 1.6;">${esc(body)}</p>${button}
           <p style="margin-top: 28px;"><a href="https://regenhub.xyz" style="color: #7fb069;">regenhub.xyz</a></p>
         </div>
       </body></html>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
