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
    ? `<form method="post" action="${esc(confirm.action)}" style="margin-top: 24px;"><button type="submit" style="font: inherit; font-size: 15px; padding: 10px 20px; border-radius: 8px; border: 0; background: #4b5a2c; color: #ebe6d9; cursor: pointer;">${esc(confirm.label)}</button></form>`
    : "";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
       <title>${esc(title)} — RegenHub</title></head>
       <body style="font-family: 'EB Garamond', Garamond, 'Iowan Old Style', Palatino, Georgia, serif; background: #ebe6d9; color: #27231d; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0;">
         <div style="max-width: 420px; padding: 40px; text-align: center;">
           <h1 style="color: ${ok ? "#4b5a2c" : "#8e2f1d"}; font-size: 22px;">${esc(title)}</h1>
           <p style="color: #514939; line-height: 1.6;">${esc(body)}</p>${button}
           <p style="margin-top: 28px;"><a href="https://regenhub.xyz" style="color: #4b5a2c;">regenhub.xyz</a></p>
         </div>
       </body></html>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
