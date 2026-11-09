/** The static parts of the phone page: HTML shell, styles, manifest and icon. */

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#11151c" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Weave">
<meta name="referrer" content="no-referrer">
<title>Weave Capture</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="app"><p class="boot">Loading…</p></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`;

export const MANIFEST = JSON.stringify({
  name: "Weave Capture",
  short_name: "Weave",
  description: "Record meetings into your pi-weave vault.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#11151c",
  theme_color: "#11151c",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
});

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#1b2433"/><circle cx="256" cy="256" r="132" fill="none" stroke="#7d9cf0" stroke-width="28"/><circle cx="256" cy="256" r="62" fill="#f06a6a"/></svg>`;

export const PAGE_CSS = `
:root{--bg:#f6f7f9;--surface:#fff;--ink:#18202b;--muted:#5b6574;--line:#dde2ea;--accent:#2f5bd3;--accent-soft:#e6ecfb;--rec:#d23b3b;--ok:#2d8a5b;--warn:#b26a00;
--body:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#11151c;--surface:#181e27;--ink:#e7ebf2;--muted:#9aa5b5;--line:#2a323e;--accent:#7d9cf0;--accent-soft:#1f2a44;--rec:#f06a6a;--ok:#5cc28f;--warn:#e0a84a;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 var(--body);-webkit-text-size-adjust:100%}
body{padding:env(safe-area-inset-top) max(16px,env(safe-area-inset-right)) env(safe-area-inset-bottom) max(16px,env(safe-area-inset-left))}
#app{max-width:640px;margin:0 auto;padding-block:16px 40px;display:grid;gap:16px}
.boot{color:var(--muted)}
h1{font-size:1.4rem;margin:0}
h2{font-size:1.1rem;margin:0}
p{margin:0}
.muted{color:var(--muted)}
.small{font-size:.85rem}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px;display:grid;gap:12px}
button,.button{font:inherit;font-weight:600;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:10px 14px;min-height:44px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--rec)}
button.link{background:none;border:none;color:var(--accent);padding:6px 0;min-height:0;font-weight:500}
button:disabled{opacity:.5;cursor:default}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
input{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);min-height:44px;width:100%}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none}
.tab{flex:none;font-size:.85rem;font-weight:500;padding:6px 12px;min-height:34px;border-radius:999px;color:var(--muted);white-space:nowrap}
.tab.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.tab .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-left:6px;vertical-align:middle}
.tab.rec{color:var(--rec);border-color:var(--rec)}
.recorder{display:grid;justify-items:center;gap:10px;padding:28px 0}
.recbtn{width:96px;height:96px;border-radius:50%;border:4px solid var(--rec);background:var(--surface);display:grid;place-items:center;padding:0}
.recbtn i{display:block;width:40px;height:40px;border-radius:50%;background:var(--rec);transition:border-radius .15s,width .15s,height .15s}
.recbtn.on i{width:34px;height:34px;border-radius:7px}
.time{font:500 2rem var(--mono);font-variant-numeric:tabular-nums}
.state{font-size:.8rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.state.live{color:var(--rec)}
.list{display:grid}
.item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:12px 0;border-top:1px solid var(--line);text-align:left;background:none;border-radius:0;border-left:0;border-right:0;border-bottom:0;font-weight:400;min-height:0}
.item small{display:block;color:var(--muted);font-size:.8rem}
.pill{font:500 .72rem var(--mono);padding:2px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.pill.new{color:var(--accent)}.pill.read{color:var(--ok)}.pill.failed{color:var(--rec)}.pill.queued,.pill.transcribing,.pill.recording{color:var(--warn)}
.transcript{font:15px/1.6 var(--body);white-space:pre-wrap;word-break:break-word;margin:0}
.codes{font:500 1rem var(--mono);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px}
.error{color:var(--rec)}
.notice{border-left:3px solid var(--warn);padding-left:10px}
`;
