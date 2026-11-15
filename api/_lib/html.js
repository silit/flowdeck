'use strict';
// Server-rendered pages. No framework: one CSS block with tokens for light and dark, an inline SVG
// sprite for the icons and a short script that turns section links into tabs. Every page also works
// without the script: the sections are then shown one after another.
// A status always pairs an icon of its own shape (check, warning sign, cross, dash) with a word.
const { summarize, summarizeDaily, checkUrlOf } = require('./checks');
const { unpublishedDays, DAY } = require('./sync');
const { PLAN_LIMITS, CMS_LIMITS } = require('./store');
const { PLANS } = require('./billing');
const att = require('./attention');

const { plural, day } = att;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const appUrl = () => (process.env.APP_URL || '').replace(/\/+$/, '');
const siteHref = (site, hash) => '/app/site?id=' + encodeURIComponent(site.id) + (hash ? '#' + hash : '');

function ago(ts, now) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor(((now || Date.now()) - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return plural(Math.floor(s / 60), 'minute') + ' ago';
  if (s < 86400) return plural(Math.floor(s / 3600), 'hour') + ' ago';
  return plural(Math.floor(s / 86400), 'day') + ' ago';
}
function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(typeof ts === 'string' ? Date.parse(ts) : ts);
  return isNaN(d) ? '-' : d.toISOString().slice(0, 10);
}
const clock = (ts) => new Date(ts).toISOString().slice(11, 16);
const dayShort = (ts) => day(ts).replace(/ \d{4}$/, '');

const CSS = `
:root{--bg:#f4f6f8;--surface:#fff;--surface-2:#f7f9fb;--fg:#121a24;--fg-2:#2c3744;--muted:#5b6876;--line:#dbe1e8;--line-2:#e8edf2;--line-strong:#bcc6d1;
--accent:#1f6feb;--accent-hover:#185ed0;--accent-ink:#fff;--link:#1a5fd0;--nav-on:#e8f0fe;--focus:#1f6feb;
--ok-fill:#1a9a5a;--ok-glyph:#fff;--ok-ink:#0e6b3f;--ok-soft:#e3f5ea;
--warn-fill:#f5b324;--warn-edge:#9a6400;--warn-glyph:#3d2a00;--warn-ink:#8a4b00;--warn-soft:#fff6e0;--warn-line:#f0d28c;
--bad-fill:#b42318;--bad-glyph:#fff;--bad-ink:#b42318;--bad-soft:#fdecea;--bad-line:#f1b8b2;
--off-edge:#7f8c99;--off-glyph:#5b6876;--info-fill:#1f6feb;--info-glyph:#fff;
--bar-ok:#1a9a5a;--bar-bad:#b42318;--bar-none:#cfd6de;color-scheme:light}
@media(prefers-color-scheme:dark){:root{--bg:#0f141a;--surface:#161d26;--surface-2:#1b2430;--fg:#e8edf2;--fg-2:#c9d2db;--muted:#9aa7b4;--line:#2a3441;--line-2:#222b36;--line-strong:#46525f;
--accent:#5b9dff;--accent-hover:#7fb2ff;--accent-ink:#0b1220;--link:#8ab8ff;--nav-on:#1c2a3e;--focus:#8ab8ff;
--ok-fill:#3fb97a;--ok-glyph:#06210f;--ok-ink:#6fdba0;--ok-soft:#133526;
--warn-fill:#f5b324;--warn-edge:#f5b324;--warn-glyph:#2b1d00;--warn-ink:#ffc266;--warn-soft:#2f2513;--warn-line:#6b5220;
--bad-fill:#d0453b;--bad-glyph:#fff;--bad-ink:#ff8a80;--bad-soft:#3a1d1a;--bad-line:#7a3530;
--off-edge:#7d8a98;--off-glyph:#9aa7b4;--info-fill:#5b9dff;--info-glyph:#0b1220;
--bar-ok:#3fb97a;--bar-bad:#f0645a;--bar-none:#3a4553;color-scheme:dark}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Figtree,"Segoe UI",Helvetica,Arial,sans-serif}
a{color:var(--link);text-underline-offset:2px}p{margin:0}
h1,h2,h3,h4{margin:0;line-height:1.25}
h1{font-family:"Bricolage Grotesque",Figtree,Arial,sans-serif;font-size:clamp(24px,3vw,30px);font-weight:700;letter-spacing:-.01em}
h2{font-size:17px;font-weight:700}h3{font-size:15px;font-weight:700}h4{font-size:14px;font-weight:700}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.vh{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip{position:absolute;left:-9999px;top:8px;z-index:20;background:var(--surface);color:var(--fg);padding:10px 14px;border-radius:10px;border:1px solid var(--line-strong);font-weight:600}.skip:focus{left:8px}
.muted{color:var(--muted)}.small{font-size:13px}.mono{font-family:"JetBrains Mono",Menlo,Consolas,monospace;font-size:12.5px}
.ic{width:16px;height:16px;flex:none;display:inline-block;vertical-align:-3px}
/* shell and sidebar */
.shell{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh;background:linear-gradient(90deg,var(--surface) 0 247px,var(--line) 247px 248px,transparent 248px)}
.side{position:sticky;top:0;height:100vh;overflow-y:auto;background:var(--surface);border-right:1px solid var(--line);padding:18px 14px 16px;display:flex;flex-direction:column;gap:18px}
.brand{display:inline-flex;align-items:center;gap:10px;padding:4px 8px;text-decoration:none;color:var(--fg);font-family:"Bricolage Grotesque",Figtree,Arial,sans-serif;font-weight:700;font-size:21px;letter-spacing:-.01em;align-self:flex-start;border-radius:8px}
.brand .deck{color:var(--accent)}.brand .logo{width:28px;height:28px;flex:none}
.nav{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0}
.nav a.ni{display:flex;align-items:center;gap:10px;min-height:42px;padding:0 10px;border-radius:9px;color:var(--fg-2);text-decoration:none;font-weight:600;font-size:14px}
.nav a.ni:hover{background:var(--surface-2);color:var(--fg)}
.nav a.ni[aria-current=page]{background:var(--nav-on);color:var(--fg);font-weight:700;box-shadow:inset 3px 0 0 var(--accent)}
.nav a.ni>.ic{width:18px;height:18px;color:var(--muted)}.nav a.ni[aria-current=page]>.ic{color:var(--accent)}
.count{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;padding:2px 8px 2px 6px;border-radius:999px;white-space:nowrap}
.count .ic{width:14px;height:14px}.count.bad{background:var(--bad-soft);color:var(--bad-ink)}.count.warn{background:var(--warn-soft);color:var(--warn-ink)}.count.ok{background:var(--ok-soft);color:var(--ok-ink)}
.sites{margin-top:14px;display:flex;flex-direction:column;gap:4px}
.sites-h{display:flex;justify-content:space-between;align-items:baseline;padding:0 10px 2px;font-size:12.5px;font-weight:700;color:var(--muted)}
.sites ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.sites li a{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:8px;min-height:36px;padding:0 10px;border-radius:8px;text-decoration:none;color:var(--fg-2);font-size:13.5px}
.sites li a:hover{background:var(--surface-2);color:var(--fg)}
.sites li a[aria-current=page]{background:var(--nav-on);color:var(--fg);font-weight:600}
.sites .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sites .w{font-size:12px;color:var(--muted);white-space:nowrap}
.sites .add,.sites .all{display:flex;align-items:center;gap:8px;min-height:36px;padding:0 10px;border-radius:8px;font-size:13.5px;font-weight:600;text-decoration:none;color:var(--link)}
.sites .add:hover,.sites .all:hover{background:var(--surface-2)}
.nav-end{margin-top:auto;padding-top:16px;display:flex;flex-direction:column;gap:2px}
.planbox{margin-bottom:10px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2);display:flex;flex-direction:column;gap:8px;font-size:12.5px;color:var(--fg-2)}
.planbox .pb-h{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.planbox b{font-size:13px;color:var(--fg)}.planbox a{font-weight:600}
.meter{display:block;height:6px;border-radius:999px;background:var(--line);overflow:hidden}.meter i{display:block;height:100%;background:var(--fg-2);border-radius:999px}
@media(max-width:900px){
.shell{display:block;background:none}
.side{position:static;height:auto;overflow:visible;flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:10px 12px;border-right:0;border-bottom:1px solid var(--line)}
.brand{font-size:19px;padding:4px}.brand .logo{width:24px;height:24px}
.nav{flex-direction:row;flex-wrap:wrap;align-items:center;flex:1 1 auto;justify-content:flex-end;gap:2px}
.nav a.ni{min-height:40px;padding:0 9px;gap:7px}.nav a.ni>.ic{display:none}.nav a.ni[aria-current=page]{box-shadow:inset 0 -3px 0 var(--accent)}
.sites,.planbox,.m-hide{display:none!important}.nav-end{display:contents}
}
/* page */
.main{min-width:0;padding:28px clamp(16px,3.4vw,40px) 40px}
.main-in{max-width:1180px}
.crumb{display:inline-flex;align-items:center;gap:6px;min-height:32px;font-size:13.5px;font-weight:600;text-decoration:none;margin-bottom:6px}
.ph{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:14px 16px;margin-bottom:22px}
.ph .sub{color:var(--muted);font-size:14px;margin-top:6px;max-width:72ch}
.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.actions form{margin:0}
.btn{font:inherit;font-weight:600;font-size:14px;line-height:1.2;min-height:42px;border-radius:10px;padding:0 16px;cursor:pointer;border:1px solid var(--line-strong);background:var(--surface);color:var(--fg);text-decoration:none;display:inline-flex;gap:8px;align-items:center;justify-content:center;white-space:nowrap}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}.btn.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn.danger{color:var(--bad-ink);border-color:var(--bad-line)}.btn.danger:hover{border-color:var(--bad-ink)}
.btn.sm{min-height:36px;padding:0 12px;font-size:13.5px;border-radius:9px}.btn .ic{width:14px;height:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px;min-width:0}
.card-h{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 12px;margin-bottom:12px}
.card-h p{color:var(--muted);font-size:13px}
.card.flush{padding:0;overflow:hidden}.card.flush>.card-h{padding:18px 20px 0}
.stack{display:flex;flex-direction:column;gap:20px;min-width:0}
.cols{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:20px;align-items:start;margin-bottom:20px}
@media(max-width:1180px){.cols{grid-template-columns:minmax(0,1fr)}}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:20px;align-items:start}
.span-all{grid-column:1/-1}
/* status marks */
.st{display:inline-flex;align-items:center;gap:7px;font-weight:600;line-height:1.3;white-space:nowrap}
.st.ok{color:var(--ok-ink)}.st.warn{color:var(--warn-ink)}.st.bad{color:var(--bad-ink)}.st.off{color:var(--muted);font-weight:500}
.legend{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px}
.legend .st{color:var(--fg-2);font-weight:500}
.legend-t{font-size:13px;color:var(--muted)}
/* notices */
.notice{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--surface);margin-bottom:18px;font-size:14px}
.notice .ic{margin-top:2px}.notice.warn{border-color:var(--warn-line);background:var(--warn-soft)}.notice.bad{border-color:var(--bad-line);background:var(--bad-soft)}
/* needs attention */
.att-list{list-style:none;margin:0;padding:0}
.att-item{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:2px 14px;align-items:start;padding:14px 0;border-top:1px solid var(--line-2)}
.att-list:first-of-type>.att-item:first-child{border-top:0;padding-top:2px}
.att-item>.ic{width:20px;height:20px;margin-top:1px}
.att-site{font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:1px}.att-site span{font-weight:400}
.att-t{font-size:15px}.att-d{font-size:13.5px;color:var(--fg-2);margin-top:3px;max-width:68ch}
.att-item>.btn{align-self:center}
@media(max-width:640px){.att-item{grid-template-columns:20px minmax(0,1fr)}.att-item>.btn{grid-column:2;justify-self:start;margin-top:10px}}
.clear{display:flex;gap:14px;align-items:flex-start}.clear .ic{width:26px;height:26px}.clear p{color:var(--fg-2);margin-top:4px}
details.more>summary{display:inline-flex;align-items:center;gap:8px;min-height:36px;margin-top:6px;padding:0 12px;border:1px solid var(--line-strong);border-radius:9px;cursor:pointer;font-weight:600;font-size:13.5px;list-style:none;background:var(--surface)}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary::after{content:"";width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-2px) rotate(45deg)}
details.more[open]>summary::after{transform:translateY(2px) rotate(-135deg)}
details.more .m-o,details.more[open] .m-c{display:none}details.more[open] .m-o{display:inline}
details.more[open]>.att-list>.att-item:first-child{border-top:1px solid var(--line-2);margin-top:12px}
/* key values */
.kv{margin:0}.kv>div{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line-2)}
.kv>div:first-child{border-top:0;padding-top:2px}.kv dt{font-size:13.5px;color:var(--fg-2)}.kv dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.kv dd small{font-weight:500;color:var(--muted);font-size:12.5px}
/* site table */
.tablewrap{overflow-x:auto;margin-top:14px;border-top:1px solid var(--line)}
.tablewrap:focus-visible{outline-offset:-3px}
.tbl{border-collapse:separate;border-spacing:0;width:100%;min-width:900px;font-size:14px}
.tbl th,.tbl td{text-align:left;padding:12px 12px;border-bottom:1px solid var(--line-2);vertical-align:middle}
.tbl th:first-child,.tbl td:first-child{padding-left:20px}.tbl th:last-child,.tbl td:last-child{padding-right:20px}
.tbl thead th{font-size:12.5px;font-weight:600;color:var(--muted);background:var(--surface);line-height:1.3}
.tbl thead th small{display:block;font-weight:500}
.tbl tbody th{font-weight:400;min-width:180px;max-width:260px}
.tbl tbody tr:last-child>*{border-bottom:0}
.tbl tbody tr:hover>*{background:var(--surface-2)}
.tbl th:first-child{position:sticky;left:0;z-index:1;background:var(--surface);box-shadow:inset -1px 0 0 var(--line-2)}
.tbl .num{font-variant-numeric:tabular-nums}.tbl .st{align-items:flex-start}.tbl .st .ic{margin-top:1px}.tbl .wrap .st{white-space:normal}
.paused{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}
.tbl .sub,.sub{display:block;font-size:12.5px;color:var(--muted);font-weight:400;margin-top:2px}
.site-link{font-weight:700;color:var(--fg);text-decoration:none}.site-link:hover{text-decoration:underline}
.host{display:block;font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.tbl-foot{padding:12px 20px 16px;border-top:1px solid var(--line-2);font-size:13px;color:var(--muted)}
/* tiles */
.tiles{list-style:none;margin:0 0 4px;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,132px),1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:5px;min-width:0}
.tile-k{font-size:12.5px;font-weight:600;color:var(--muted)}.tile-v{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
.tile .st{font-size:15px;white-space:normal;align-items:flex-start}.tile .st .ic{margin-top:2px}.tile-s{font-size:12.5px;color:var(--muted)}
@media(max-width:520px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
/* tabs */
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:28px 0 20px}
.tabs a{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;color:var(--muted);text-decoration:none;font-weight:600;font-size:14.5px;border-bottom:3px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs a:hover{color:var(--fg)}.tabs a[aria-selected=true]{color:var(--fg);border-bottom-color:var(--accent);font-weight:700}
.tab-n{font-size:12px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--warn-soft);color:var(--warn-ink)}
@media(max-width:600px){.tabs{flex-wrap:wrap;gap:8px;border-bottom:0}.tabs a{min-height:40px;border:1px solid var(--line-strong);border-radius:999px;margin:0;padding:0 14px;background:var(--surface)}.tabs a[aria-selected=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}}
.panel{min-width:0}.panel+.panel{margin-top:32px}
.panel-h{font-size:18px;margin-bottom:14px}.js-tabs .panel-h{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* uptime bars */
.bars{display:flex;align-items:flex-end;gap:2px;height:56px;margin-top:12px}
.bars i{flex:1 1 0;min-width:0;height:100%;border-radius:2px;background:var(--bar-ok)}
.bars i.bad{background:var(--bar-bad)}.bars i.none{height:5px;background:var(--bar-none)}
.bars-axis{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:4px}
.facts{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13.5px;color:var(--fg-2)}.facts b{color:var(--fg)}
.list{list-style:none;margin:8px 0 0;padding:0;font-size:14px}.list li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--line-2)}.list li:first-child{border-top:0}
.list li span:last-child{color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
.mini{width:100%;border-collapse:collapse;font-size:14px;margin-top:4px}
.mini th,.mini td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line-2)}.mini th:first-child,.mini td:first-child{padding-left:0}
.mini th{font-size:12.5px;color:var(--muted);font-weight:600}.mini .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.mini tr:last-child td{border-bottom:0}
.seo-g{padding:14px 0;border-top:1px solid var(--line-2)}.seo-g:first-child{border-top:0;padding-top:0}
.seo-g h4{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px}
.pages{list-style:none;margin:8px 0 0;padding:0;font-size:14px;display:grid;gap:4px}.pages li{display:flex;flex-wrap:wrap;gap:4px 10px}.pages a,.pages .path{font-family:"JetBrains Mono",Menlo,Consolas,monospace;font-size:12.5px;overflow-wrap:anywhere}
.pages .len{color:var(--muted);font-size:12.5px}
.none-list{margin-top:14px;padding-top:14px;border-top:1px solid var(--line-2);font-size:13.5px;color:var(--fg-2)}
/* forms */
.fields{display:grid;gap:14px}.field{display:grid;gap:6px}label{font-size:13.5px;font-weight:600}.hint{font-size:12.5px;color:var(--muted)}
input[type=text],input[type=email],input[type=url],select{width:100%;min-height:42px;font:inherit;font-size:14px;color:var(--fg);background:var(--surface);border:1px solid var(--line-strong);border-radius:10px;padding:8px 12px}
input[readonly]{background:var(--surface-2)}
.check{display:flex;gap:10px;align-items:flex-start;font-size:14px;font-weight:400;line-height:1.45}.check input{width:18px;height:18px;margin:1px 0 0;accent-color:var(--accent);flex:none}
.copy{display:flex;gap:8px;margin:14px 0 12px}.copy input{flex:1 1 auto;min-width:0}
.plans{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:10px}
.plans li{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;border:1px solid var(--line);border-radius:12px}
.plans li.cur{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.plans .pr{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.plans form{margin:0}
.conns{list-style:none;margin:12px 0 0;padding:0}.conns li{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;padding:12px 0;border-top:1px solid var(--line-2)}.conns li:first-child{border-top:0}
.danger-zone{border-color:var(--bad-line)}
/* public pages */
.pub-top{background:var(--surface);border-bottom:1px solid var(--line)}
.pub-in{max-width:1080px;margin:0 auto;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.pub-nav{display:flex;gap:4px;flex-wrap:wrap}.pub-nav a{display:inline-flex;align-items:center;min-height:40px;padding:0 10px;border-radius:8px;color:var(--fg-2);text-decoration:none;font-weight:600;font-size:14px}.pub-nav a:hover{background:var(--surface-2)}
.pub-main{max-width:1080px;margin:0 auto;padding:32px 16px 40px}
.narrow{max-width:560px}
.foot{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--muted);display:flex;flex-wrap:wrap;gap:8px 20px}
.foot a{color:var(--muted)}
`;

// Icons. Status shapes: check in a circle, warning sign, cross in a square, dash in a dashed circle.
// Their colours come from the tokens above, so they follow the light and dark theme.
const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false">
<symbol id="i-ok" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7.5" style="fill:var(--ok-fill)"/><path d="M4.6 8.3l2.3 2.3 4.5-4.8" style="fill:none;stroke:var(--ok-glyph);stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round"/></symbol>
<symbol id="i-warn" viewBox="0 0 16 16"><path d="M6.92 1.95a1.25 1.25 0 0 1 2.16 0l6.17 10.9a1.25 1.25 0 0 1-1.08 1.87H1.83A1.25 1.25 0 0 1 .75 12.85z" style="fill:var(--warn-fill);stroke:var(--warn-edge);stroke-width:1"/><path d="M8 5.7v3.9" style="fill:none;stroke:var(--warn-glyph);stroke-width:1.8;stroke-linecap:round"/><circle cx="8" cy="12" r="1.05" style="fill:var(--warn-glyph)"/></symbol>
<symbol id="i-bad" viewBox="0 0 16 16"><rect x=".5" y=".5" width="15" height="15" rx="3.5" style="fill:var(--bad-fill)"/><path d="M5.3 5.3l5.4 5.4m0-5.4l-5.4 5.4" style="fill:none;stroke:var(--bad-glyph);stroke-width:1.9;stroke-linecap:round"/></symbol>
<symbol id="i-off" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.9" style="fill:none;stroke:var(--off-edge);stroke-width:1.3;stroke-dasharray:2.2 1.9"/><path d="M5.3 8h5.4" style="fill:none;stroke:var(--off-glyph);stroke-width:1.9;stroke-linecap:round"/></symbol>
<symbol id="i-info" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7.5" style="fill:var(--info-fill)"/><path d="M8 7.3v4.1" style="fill:none;stroke:var(--info-glyph);stroke-width:1.9;stroke-linecap:round"/><circle cx="8" cy="4.9" r="1.1" style="fill:var(--info-glyph)"/></symbol>
<symbol id="n-overview" viewBox="0 0 16 16"><g style="fill:none;stroke:currentColor;stroke-width:1.6;stroke-linejoin:round"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/></g></symbol>
<symbol id="n-settings" viewBox="0 0 16 16"><g style="fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round"><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.6"/><circle cx="6" cy="11.5" r="1.6"/></g></symbol>
<symbol id="n-help" viewBox="0 0 16 16"><g style="fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round"><circle cx="8" cy="8" r="6.3"/><path d="M6.2 6.3a1.85 1.85 0 1 1 2.6 1.7c-.5.25-.8.65-.8 1.2v.3"/></g><circle cx="8" cy="11.6" r=".95" style="fill:currentColor"/></symbol>
<symbol id="n-out" viewBox="0 0 16 16"><path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M10 5l3 3-3 3M13 8H6.5" style="fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round"/></symbol>
<symbol id="n-plus" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" style="fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round"/></symbol>
<symbol id="n-ext" viewBox="0 0 16 16"><path d="M6 3h7v7M13 3L5 11" style="fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"/></symbol>
<symbol id="n-back" viewBox="0 0 16 16"><path d="M10 3.5L5.5 8l4.5 4.5" style="fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round"/></symbol>
</svg>`;

// The Flowdeck mark (assets/logo.svg)
const LOGO = '<svg class="logo" viewBox="0 0 900 900" aria-hidden="true" focusable="false"><rect width="900" height="900" rx="200" fill="#1f6feb"/><rect x="190" y="200" width="520" height="120" rx="40" fill="#fff"/><rect x="190" y="390" width="520" height="120" rx="40" fill="#fff" opacity=".85"/><rect x="190" y="580" width="520" height="120" rx="40" fill="#fff" opacity=".7"/><circle cx="250" cy="260" r="28" fill="#1a9a5a"/><circle cx="250" cy="450" r="28" fill="#1a9a5a"/><circle cx="250" cy="640" r="28" fill="#c9372c"/></svg>';

// Section links become tabs: arrow keys move between them, the chosen one is kept in the address
// (#seo, #plan ...) so a reload or a link opens it, and a link to anything inside a tab opens that tab.
const SCRIPT = `(function(){
var nav=document.querySelector('[data-tabs]');
if(nav){var links=[].slice.call(nav.querySelectorAll('a[href^="#"]'));var panels=links.map(function(a){return document.getElementById(a.getAttribute('href').slice(1));});
if(links.length&&panels.every(Boolean)){
document.documentElement.classList.add('js-tabs');nav.setAttribute('role','tablist');
links.forEach(function(a,i){a.setAttribute('role','tab');a.id='tab-'+panels[i].id;a.setAttribute('aria-controls',panels[i].id);panels[i].setAttribute('role','tabpanel');panels[i].setAttribute('aria-labelledby',a.id);});
var show=function(i,focus,keep){links.forEach(function(a,j){var on=j===i;a.setAttribute('aria-selected',on?'true':'false');a.tabIndex=on?0:-1;panels[j].hidden=!on;});if(focus)links[i].focus();if(keep)history.replaceState(null,'','#'+panels[i].id);};
var find=function(id){if(!id)return -1;var el=document.getElementById(id);for(var i=0;i<panels.length;i++){if(panels[i]===el||(el&&panels[i].contains(el)))return i;}return -1;};
nav.addEventListener('click',function(e){var a=e.target.closest('[role=tab]');if(!a)return;e.preventDefault();show(links.indexOf(a),false,true);});
nav.addEventListener('keydown',function(e){var i=links.indexOf(document.activeElement);if(i<0)return;var k=e.key,n=k==='ArrowRight'?i+1:k==='ArrowLeft'?i-1:k==='Home'?0:k==='End'?links.length-1:null;if(n===null)return;e.preventDefault();show((n+links.length)%links.length,true,true);});
document.addEventListener('click',function(e){var a=e.target.closest('a[href^="#"]');if(!a||nav.contains(a))return;var id=a.getAttribute('href').slice(1),i=find(id);if(i<0)return;e.preventDefault();show(i,false,false);history.replaceState(null,'','#'+id);var el=document.getElementById(id);(el===panels[i]?nav:el).scrollIntoView({block:'start'});});
var id=location.hash.slice(1),start=find(id);if(start<0)start=find(nav.getAttribute('data-default'));show(start<0?0:start,false,false);
if(id&&start>=0){var el=document.getElementById(id);(el===panels[start]?nav:el).scrollIntoView({block:'start'});}
window.addEventListener('hashchange',function(){var i=find(location.hash.slice(1));if(i>=0)show(i,false,false);});}}
[].forEach.call(document.querySelectorAll('[data-copy]'),function(b){var el=document.getElementById(b.getAttribute('data-copy'));if(!el||!navigator.clipboard)return;b.hidden=false;b.addEventListener('click',function(){navigator.clipboard.writeText(el.value).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy link';},2000);},function(){el.select();});});});
})();`;

/* ---------- small parts ---------- */

const ICONS = { ok: 'i-ok', warn: 'i-warn', bad: 'i-bad', off: 'i-off', info: 'i-info' };
function icon(name, cls) {
  const id = ICONS[name] || name;
  return `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
}
// A status: icon plus word. `word` is plain text.
function st(kind, word) { return `<span class="st ${kind}">${icon(kind)}${esc(word)}</span>`; }
const SEV_WORD = { bad: 'Urgent', warn: 'Needs a look', ok: 'OK', off: 'No data' };
const EXT = `${icon('n-ext')}<span class="vh"> (opens in a new tab)</span>`;

function btnLink(a, kind) {
  const ext = a.ext ? ' target="_blank" rel="noopener"' : '';
  return `<a class="btn sm${kind ? ' ' + kind : ''}" href="${esc(a.href)}"${ext}>${esc(a.label)}${a.ext ? EXT : ''}</a>`;
}

// Messages about something that went wrong get the warning look; confirmations get the plain one.
const WARN_RE = /refused|was removed \(|deleted the stored token|not allowed|could not|failed|plan monitors up to/i;
function noticeBox(html) {
  if (!html) return '';
  const warn = WARN_RE.test(html);
  return `<div class="notice${warn ? ' warn' : ''}" role="status">${icon(warn ? 'warn' : 'info')}<div>${html}</div></div>`;
}

function pageHead(o) {
  return `${o.crumb || ''}<div class="ph"><div><h1>${o.title}</h1>${o.sub ? `<p class="sub">${o.sub}</p>` : ''}</div>${o.actions ? `<div class="actions">${o.actions}</div>` : ''}</div>`;
}

function legend() {
  return `<ul class="legend" aria-label="What the marks mean">
<li>${st('ok', 'OK')}</li><li>${st('warn', 'Needs a look')}</li><li>${st('bad', 'Down or broken')}</li><li>${st('off', 'Waiting, paused or no data yet')}</li></ul>`;
}

function footer() {
  return `<footer class="foot"><span>Flowdeck</span><a href="/docs">Docs</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><span>Not affiliated with Webflow.</span></footer>`;
}

function limitOf(user) { return user._limit || PLAN_LIMITS[user.plan] || PLAN_LIMITS.free; }
function planName(user) { return user.plan && user.plan !== 'free' && PLANS[user.plan] ? PLANS[user.plan].name : 'Free'; }
function planLabel(user, limit) {
  const paid = user.plan && user.plan !== 'free' && PLANS[user.plan];
  const base = paid ? PLAN_LIMITS[user.plan] : PLAN_LIMITS.free;
  const name = paid ? PLANS[user.plan].name : 'Free';
  return limit > base ? `${name} plan, complimentary limit of ${limit} sites` : `${name} plan, up to ${limit} site${limit === 1 ? '' : 's'}`;
}
function lastFetched(sites, now) {
  const ts = sites.map((s) => s.syncedAt || 0).filter(Boolean);
  return ts.length ? ago(Math.min(...ts), now) : 'not yet';
}
function accountItems(sites, user, now) {
  return att.rank(sites, now, { limit: { max: limitOf(user), planName: planName(user) } });
}

/* ---------- page frames ---------- */

function doc(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title>
<link rel="icon" href="/favicon.png"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Figtree:wght@400;500;600;700&family=JetBrains+Mono:wght@400&display=swap">
<style>${CSS}</style></head><body>${SPRITE}
${inner}
<script>${SCRIPT}</script></body></html>`;
}

// What a site looks like in one word, for the sidebar list.
function siteWord(site, now) {
  if (!site.monitored) return ['off', 'Paused'];
  const st = site.status || {};
  const items = att.siteItems(site, now);
  if (st.up === false) return ['bad', 'Down'];
  if (items.length) return [items.some((i) => i.sev === 'bad') ? 'bad' : 'warn', `${items.length} to fix`];
  if (st.up === true) return ['ok', 'Up'];
  return ['off', 'Pending'];
}

function sidebar(opts) {
  const user = opts.user;
  const now = opts.now || Date.now();
  const sites = opts.sites;
  const limit = limitOf(user);
  const items = sites ? accountItems(sites, user, now) : null;
  const anyBad = items && items.some((i) => i.sev === 'bad');
  const badge = !items || !sites.length ? '' : items.length ? `<span class="count ${anyBad ? 'bad' : 'warn'}">${icon(anyBad ? 'bad' : 'warn')}${items.length} to fix</span>` : `<span class="count ok">${icon('ok')}All clear</span>`;
  const cur = (name) => (opts.active === name ? ' aria-current="page"' : '');
  const list = (sites || (opts.site ? [opts.site] : [])).slice().sort((a, b) => (b.monitored - a.monitored) || att.nameOf(a).localeCompare(att.nameOf(b)));
  const MAX = 12;
  const siteLinks = list.slice(0, MAX).map((s) => {
    const [kind, word] = siteWord(s, now);
    const on = opts.site && opts.site.id === s.id ? ' aria-current="page"' : '';
    return `<li><a href="${siteHref(s)}"${on} title="${esc(att.nameOf(s))}: ${esc(word)}">${icon(kind)}<span class="nm">${esc(att.nameOf(s))}</span><span class="w">${esc(word)}</span></a></li>`;
  }).join('');
  const monitored = (sites || []).filter((s) => s.monitored).length;
  const paid = user.plan && user.plan !== 'free';
  const planBox = sites ? `<div class="planbox"><div class="pb-h"><b>${esc(planName(user))} plan</b><a href="/app/settings#plan">${paid ? 'Manage' : 'Upgrade'}</a></div><span class="meter" aria-hidden="true"><i style="width:${Math.min(100, Math.round((monitored / Math.max(1, limit)) * 100))}%"></i></span><span>${monitored} of ${plural(limit, 'site')} monitored.</span></div>` : '';
  return `<aside class="side">
<a class="brand" href="/app">${LOGO}<span>Flow<span class="deck">deck</span></span></a>
<nav class="nav" aria-label="Main">
<a class="ni" href="/app"${cur('overview')}>${icon('n-overview')}Overview${badge}</a>
${list.length ? `<div class="sites"><div class="sites-h"><span>Sites</span><span>${sites ? sites.length : ''}</span></div><ul>${siteLinks}</ul>${list.length > MAX ? `<a class="all" href="/app#sites">All ${list.length} sites</a>` : ''}<a class="add" href="/auth">${icon('n-plus')}Connect sites</a></div>` : ''}
<div class="nav-end">${planBox}
<a class="ni" href="/app/settings"${cur('settings')}>${icon('n-settings')}Settings</a>
<a class="ni m-hide" href="/docs">${icon('n-help')}Help</a>
<a class="ni" href="/logout">${icon('n-out')}Sign out</a>
</div>
</nav>
</aside>`;
}

function layout(title, body, opts) {
  opts = opts || {};
  if (opts.user) {
    return doc(title, `<a class="skip" href="#main">Skip to content</a><div class="shell">${sidebar(opts)}<main id="main" class="main"><div class="main-in">
${body}
${footer()}
</div></main></div>`);
  }
  const nav = opts.plain ? '' : `<nav class="pub-nav" aria-label="Main"><a href="/">Home</a><a href="/docs">Docs</a><a href="/login">Sign in</a></nav>`;
  return doc(title, `<a class="skip" href="#main">Skip to content</a><header class="pub-top"><div class="pub-in"><a class="brand" href="/">${LOGO}<span>Flow<span class="deck">deck</span></span></a>${nav}</div></header>
<main id="main" class="pub-main">
${body}
${footer()}
</main>`);
}

/* ---------- public pages ---------- */

function loginPage(q) {
  const msg = q.sent ? `<div class="notice" role="status">${icon('info')}<div>If that email belongs to a Flowdeck account, a sign in link is on its way. It works once and expires in 15 minutes.</div></div>`
    : q.bad ? `<div class="notice bad" role="alert">${icon('bad')}<div>That email address does not look right.</div></div>` : '';
  return layout('Sign in · Flowdeck', `<h1 style="margin-bottom:20px">Sign in to Flowdeck</h1>${msg}
<div class="grid2">
<section class="card" aria-labelledby="in-h"><h2 id="in-h">Sign in</h2><p class="muted" style="margin:6px 0 16px">Enter the email of your Webflow account. We send you a one-time sign in link, so you do not have to authorize Webflow again.</p>
<form method="post" action="/login" class="fields"><div class="field"><label for="email">Email</label><input type="email" id="email" name="email" required autocomplete="email"></div>
<div class="actions"><button class="btn primary" type="submit">Email me a sign in link</button></div></form></section>
<section class="card" aria-labelledby="new-h"><h2 id="new-h">New to Flowdeck?</h2><p class="muted" style="margin:6px 0 16px">Install Flowdeck by authorizing it in Webflow. You choose which sites or workspace it can read; access is read only.</p>
<div class="actions"><a class="btn" href="/auth">Connect your Webflow sites</a></div></section>
</div>`);
}

function loginConfirm(token) {
  return layout('Sign in · Flowdeck', `<section class="card narrow" aria-labelledby="c-h"><h1 id="c-h" style="font-size:24px">Sign in to Flowdeck</h1><p class="muted" style="margin:8px 0 16px">Press the button to finish signing in.</p>
<form method="post" action="/l/${esc(token)}"><button class="btn primary" type="submit">Sign in</button></form></section>`);
}

function errorPage(title, message, back) {
  return layout(title, `<section class="card narrow" aria-labelledby="e-h"><div class="clear">${icon('bad')}<div><h1 id="e-h" style="font-size:24px">${esc(title)}</h1><p style="margin-top:8px">${esc(message)}</p></div></div><div class="actions" style="margin-top:18px"><a class="btn primary" href="${esc(back || '/app')}">Back</a></div></section>`);
}

/* ---------- needs attention ---------- */

// The one button for an item. On the overview it leads to where the problem is explained or fixed;
// on the site page, where it can be fixed (the live site, the Designer, a section of the page).
function actionFor(item, ctx) {
  const s = item.site;
  if (item.type === 'limit') return { href: '/app/settings#plan', label: 'See plans' };
  if (item.type === 'access') return { href: '/auth', label: 'Connect again' };
  const designer = att.designerUrl(s);
  if (ctx === 'site') {
    if (item.type === 'down') return { href: checkUrlOf(s) || s.url, label: 'Open the site', ext: true };
    if (item.type === 'ssl' || item.type === 'forms_silent') return { href: s.url, label: 'Open the site', ext: true };
    if (item.type === 'cms') return { href: '#cms', label: 'See collections' };
    if (item.type === 'unpublished') return designer ? { href: designer, label: 'Open the Designer', ext: true } : { href: '#publishing', label: 'See publishing' };
    if (item.type === 'seo') return { href: '#seo', label: 'See the pages' };
  }
  if (item.type === 'down') return { href: siteHref(s, 'uptime'), label: 'See what failed' };
  if (item.type === 'ssl') return { href: siteHref(s), label: 'See SSL details' };
  if (item.type === 'forms_silent') return { href: siteHref(s, 'forms'), label: 'See the forms' };
  if (item.type === 'cms') return { href: siteHref(s, 'cms'), label: 'See collections' };
  if (item.type === 'unpublished') return designer ? { href: designer, label: 'Open the Designer', ext: true } : { href: siteHref(s, 'publishing'), label: 'See publishing' };
  if (item.type === 'seo') return { href: siteHref(s, 'seo'), label: 'See the pages' };
  return { href: siteHref(s), label: 'Open the site page' };
}

function attentionCard(items, ctx, opts) {
  opts = opts || {};
  if (!items.length) {
    return `<section class="card clear" aria-labelledby="att-h">${icon('ok')}<div><h2 id="att-h">${esc(opts.clearTitle || 'All clear')}</h2><p>${esc(opts.clearText || 'Nothing needs attention right now.')}</p></div></section>`;
  }
  const anyBad = items.some((i) => i.sev === 'bad');
  const row = (i, n) => {
    const a = i.action || actionFor(i, ctx);
    const primary = i.sev === 'bad' || (!anyBad && n === 0);
    const siteLine = ctx === 'overview' && i.site ? `<p class="att-site">${esc(att.nameOf(i.site))} <span>${esc(att.hostOf(i.site))}</span></p>` : '';
    return `<li class="att-item ${i.sev}">${icon(i.sev)}<div>${siteLine}<h3 class="att-t"><span class="vh">${SEV_WORD[i.sev]}: </span>${esc(i.title)}</h3><p class="att-d">${esc(i.detail)}</p></div>${btnLink(a, primary ? 'primary' : '')}</li>`;
  };
  const SHOW = 5;
  const rest = items.slice(SHOW);
  return `<section class="card att" aria-labelledby="att-h">
<div class="card-h"><h2 id="att-h">${esc(opts.title || 'Needs attention now')}</h2><p>${items.length === 1 ? '1 item' : items.length + ' items, most urgent first'}</p></div>
<ol class="att-list">${items.slice(0, SHOW).map(row).join('')}</ol>
${rest.length ? `<details class="more"><summary><span class="m-c">Show all ${items.length}</span><span class="m-o">Show fewer</span></summary><ol class="att-list" start="${SHOW + 1}">${rest.map((i, k) => row(i, SHOW + k)).join('')}</ol></details>` : ''}
</section>`;
}

/* ---------- cells shared by the table, the site page and the report ---------- */

function statusOf(site) {
  if (!site.monitored) return ['off', 'Paused'];
  const s = site.status || {};
  if (s.up === true) return ['ok', 'Up'];
  if (s.up === false) return ['bad', 'Down'];
  return ['off', 'Pending'];
}
// [kind, words, short words for the table]
function sslOf(site, now) {
  const x = att.sslState(site, now);
  if (x.state === 'none') return ['off', 'Not checked yet', 'Not checked'];
  if (x.state === 'invalid') return ['bad', 'Not valid', 'Not valid'];
  if (x.state === 'expired') return ['bad', 'Expired', 'Expired'];
  if (x.state === 'expiring') return x.days < 1 ? ['warn', 'Expires today', 'Today'] : ['warn', `${plural(x.days, 'day')} left`, plural(x.days, 'day')];
  if (x.state === 'error') return ['warn', 'Needs a check', 'Check'];
  return ['ok', `${plural(x.days, 'day')} left`, plural(x.days, 'day')];
}
// [kind, words, short words for the table, second line for the table]
function publishOf(site, now) {
  const ud = unpublishedDays(site, now);
  if (ud == null) return ['ok', 'Published', 'Published', day(site.lastPublished)];
  const span = ud < 1 ? 'under a day' : plural(ud, 'day');
  return [ud >= 7 ? 'warn' : 'off', `Unpublished for ${span}`, 'Unpublished', 'for ' + span];
}
function cmsOf(site) {
  const u = att.cmsUsage(site);
  if (!u) return null;
  if (!u.limit) return { text: String(u.total) };
  const text = `${u.total} / ${u.limit}${u.pct >= 90 ? ' (' + u.pct + '%)' : ''}`;
  return { kind: u.pct >= 100 ? 'bad' : u.pct >= 90 ? 'warn' : 'ok', text };
}
function seoOf(site) {
  const p = site.data && site.data.pages;
  if (!p) return ['off', 'Not synced yet'];
  return p.issues ? ['warn', plural(p.issues, 'issue')] : ['ok', 'None'];
}

/* ---------- overview ---------- */

function dashboard(user, sites, checksBySite, now, notice) {
  now = now || Date.now();
  const limit = limitOf(user);
  const monitored = sites.filter((s) => s.monitored);
  const down = monitored.filter((s) => s.status && s.status.up === false).length;
  const unpub = monitored.filter((s) => (unpublishedDays(s, now) || 0) >= 7).length;
  const forms7 = monitored.reduce((a, s) => a + ((s.data && s.data.forms && s.data.forms.total7) || 0), 0);
  const seo = monitored.reduce((a, s) => a + ((s.data && s.data.pages && s.data.pages.issues) || 0), 0);
  const items = accountItems(sites, user, now);

  const head = pageHead({
    title: 'Overview',
    sub: `${monitored.length} monitored · ${esc(planLabel(user, limit))} · checks every 5 minutes · Webflow data fetched ${lastFetched(sites, now)}`,
    actions: `<form method="post" action="/app/sync"><button class="btn" type="submit">Refresh data</button></form><a class="btn${sites.length ? '' : ' primary'}" href="/auth">${icon('n-plus')}Connect sites</a>`
  });
  if (!sites.length) {
    return layout('Flowdeck', `${noticeBox(notice)}${head}
<section class="card clear" aria-labelledby="empty-h">${icon('info')}<div><h2 id="empty-h">No sites yet</h2><p>Connect your Webflow sites to start monitoring. Access is read only.</p><div class="actions" style="margin-top:14px"><a class="btn primary" href="/auth">Connect your Webflow sites</a></div></div></section>`, { user, sites, now, active: 'overview' });
  }

  const glance = `<section class="card" aria-labelledby="gl-h"><div class="card-h"><h2 id="gl-h">At a glance</h2></div><dl class="kv">
<div><dt>Sites monitored</dt><dd>${monitored.length} <small>of ${limit}</small></dd></div>
<div><dt>Down now</dt><dd>${down ? st('bad', String(down)) : st('ok', 'None')}</dd></div>
<div><dt>Unpublished 7 days or more</dt><dd>${unpub ? st('warn', String(unpub)) : st('ok', 'None')}</dd></div>
<div><dt>Form submissions, 7 days</dt><dd>${forms7}</dd></div>
<div><dt>SEO issues</dt><dd>${seo ? st('warn', String(seo)) : st('ok', 'None')}</dd></div>
</dl></section>`;

  const score = new Map(sites.map((s) => [s.id, att.siteScore(s, now)]));
  const ordered = monitored.slice().sort((a, b) => (score.get(b.id) - score.get(a.id)) || att.nameOf(a).localeCompare(att.nameOf(b)))
    .concat(sites.filter((s) => !s.monitored));
  const rows = ordered.map((s) => {
    const name = `<th scope="row"><a class="site-link" href="${siteHref(s)}">${esc(att.nameOf(s))}</a><span class="host">${esc(s.url.replace(/^https?:\/\//, ''))}</span></th>`;
    if (!s.monitored) {
      const why = s.pausedByUser ? `You paused monitoring. <a href="${siteHref(s, 'settings')}">Resume</a>` : `Over your plan limit of ${limit} site${limit === 1 ? '' : 's'}. <a href="/app/settings#plan">Upgrade</a> to monitor it.`;
      return `<tr>${name}<td colspan="6"><div class="paused">${st('off', 'Paused')}<span class="muted small">${why}</span></div></td></tr>`;
    }
    const sum = summarize(checksBySite[s.id] || [], now - 7 * DAY);
    const f = s.data && s.data.forms;
    const silent = f && f.total30 === 0 && f.before30 > 0;
    const cms = cmsOf(s);
    const [sk, sw] = statusOf(s), [lk, , ls] = sslOf(s, now), [pk, , ps, psub] = publishOf(s, now), [ek, ew] = seoOf(s);
    const upLine = [sum.uptime == null ? 'No checks yet' : sum.uptime + '%', s.status && s.status.ms != null ? s.status.ms + ' ms' : ''].filter(Boolean).join(' · ');
    return `<tr>${name}
<td>${st(sk, sw)}<span class="sub">${esc(upLine)}</span></td>
<td>${st(lk, ls)}</td>
<td>${st(pk, ps)}${psub ? `<span class="sub">${esc(psub)}</span>` : ''}</td>
${f ? `<td class="num">${f.total7} <span class="muted">/ ${f.total30}</span>${silent ? `<span class="sub">${st('warn', 'Silent')}</span>` : ''}</td>` : `<td>${st('off', 'Not synced')}</td>`}
<td class="num wrap">${cms ? (cms.kind ? st(cms.kind, cms.text) : cms.text) : st('off', 'Not synced')}</td>
<td>${st(ek, ew)}</td>
</tr>`;
  }).join('');

  const body = `${noticeBox(notice)}${head}
<div class="cols">${attentionCard(items, 'overview', { clearText: 'Nothing needs attention right now. Every monitored site is up, published and inside its limits.' })}${glance}</div>
<section class="card flush" id="sites" aria-labelledby="tbl-h">
<div class="card-h"><h2 id="tbl-h">All sites, most urgent first</h2>${legend()}</div>
<div class="tablewrap" role="region" aria-labelledby="tbl-h" tabindex="0"><table class="tbl">
<thead><tr><th scope="col">Site</th><th scope="col">Status<small>Uptime 7d · response</small></th><th scope="col">SSL<small>Days left</small></th><th scope="col">Publishing</th><th scope="col">Forms<small>7d / 30d</small></th><th scope="col">CMS items</th><th scope="col">SEO</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<p class="tbl-foot">Form counts and SEO checks refresh a few times a day; uptime and SSL every 5 minutes. Open a site for details and the client report link.</p>
</section>`;
  return layout('Flowdeck', body, { user, sites, now, active: 'overview' });
}

/* ---------- site page ---------- */

// Uptime bars: 7 days in 84 buckets of 2 hours. A full green bar means every check passed, a short
// red bar that some failed (the shorter, the more), a thin grey bar that there were no checks.
function uptimeBars(checks, now) {
  const buckets = Array.from({ length: 84 }, () => ({ ok: 0, bad: 0 }));
  const start = now - 7 * DAY;
  for (const c of checks) {
    if (c.t < start) continue;
    const i = Math.min(83, Math.floor((c.t - start) / (2 * 3600000)));
    if (c.ok) buckets[i].ok++; else buckets[i].bad++;
  }
  const failed = buckets.filter((b) => b.bad).length;
  return `<div class="bars" role="img" aria-label="Last 7 days in 2 hour bars: ${failed ? plural(failed, 'bar') + ' with failed checks' : 'no failed checks'}">${buckets.map((b) => {
    if (!b.ok && !b.bad) return '<i class="none"></i>';
    if (!b.bad) return '<i></i>';
    return `<i class="bad" style="height:${Math.round(14 + (b.ok / (b.ok + b.bad)) * 30)}%"></i>`;
  }).join('')}</div><div class="bars-axis" aria-hidden="true"><span>7 days ago</span><span>Now</span></div>`;
}
// Runs of failed checks (5 minutes apart), newest first
function outages(checks, since) {
  const failed = checks.filter((c) => c.t >= since && !c.ok).sort((a, b) => a.t - b.t);
  const out = [];
  for (const c of failed) {
    const last = out[out.length - 1];
    if (last && c.t - last.end <= 15 * 60000) { last.end = c.t; last.n++; } else out.push({ start: c.t, end: c.t, n: 1 });
  }
  return out.reverse();
}
function outageText(o) {
  const same = dayShort(o.start) === dayShort(o.end);
  const when = o.start === o.end ? `${dayShort(o.start)}, ${clock(o.start)} UTC` : same ? `${dayShort(o.start)}, ${clock(o.start)} to ${clock(o.end)} UTC` : `${dayShort(o.start)} ${clock(o.start)} to ${dayShort(o.end)} ${clock(o.end)} UTC`;
  return `${when}: ${plural(o.n, 'failed check')}`;
}
const BARS_LEGEND = 'Each bar is 2 hours. Full green bar: every check passed. Short red bar: some checks failed. Thin grey bar: no checks.';

function issueList(items, kind, site) {
  const SHOW = 5, MAX = 100;
  const li = (i) => {
    if (kind === 'dup') return `<li><span>"${esc(i.title)}"</span><span>on ${i.pages.map((p) => `<span class="path">${esc(p.path)}</span>`).join(', ')}</span></li>`;
    let href = ''; // a link to the live page, only when it stays on the site's own address
    try { const u = new URL(i.path, site.url); if (/^https?:$/.test(u.protocol) && u.host === new URL(site.url).host) href = u.href; } catch (e) { href = ''; }
    return `<li><span>${esc(i.label)}</span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(i.path)}<span class="vh"> (opens in a new tab)</span></a>` : `<span class="path">${esc(i.path)}</span>`}${i.length ? `<span class="len">${i.length} characters</span>` : ''}</li>`;
  };
  const shown = items.slice(0, SHOW).map(li).join('');
  const rest = items.slice(SHOW, MAX);
  return `<ul class="pages">${shown}</ul>${rest.length ? `<details class="more"><summary><span class="m-c">Show all ${items.length}</span><span class="m-o">Show fewer</span></summary><ul class="pages" style="margin-top:8px">${rest.map(li).join('')}</ul>${items.length > MAX ? `<p class="muted small" style="margin-top:6px">and ${items.length - MAX} more</p>` : ''}</details>` : ''}`;
}

function siteDetail(user, site, checks, now, notice, opts) {
  now = now || Date.now();
  opts = opts || {};
  const s7 = summarize(checks, now - 7 * DAY); // checks are kept for 7 days
  const st0 = site.status || {};
  const s30 = summarizeDaily(st0.daily, now - 30 * DAY); // daily totals for 30 days
  const f = site.data && site.data.forms;
  const p = site.data && site.data.pages;
  const cms = site.data && site.data.cms;
  const reportUrl = site.settings.reportToken ? `${appUrl()}/r/${site.settings.reportToken}` : '';
  const host = att.hostOf(site);
  const designer = att.designerUrl(site);
  const items = att.siteItems(site, now).sort((a, b) => b.score - a.score);
  const name = att.nameOf(site);

  const head = pageHead({
    crumb: `<a class="crumb" href="/app">${icon('n-back')}All sites</a>`,
    title: esc(name),
    sub: `<a href="${esc(site.url)}" target="_blank" rel="noopener">${esc(host)}<span class="vh"> (opens in a new tab)</span></a>${site.settings.client && site.settings.client !== site.name ? ` · Webflow site: ${esc(site.name)}` : ''}${st0.lastCheckAt ? ` · checked ${ago(st0.lastCheckAt, now)}` : ''} · Webflow data fetched ${ago(site.syncedAt, now)}`,
    actions: `<form method="post" action="/app/sync"><input type="hidden" name="id" value="${esc(site.id)}"><button class="btn" type="submit">Refresh data</button></form><a class="btn" href="${esc(site.url)}" target="_blank" rel="noopener">Open site${EXT}</a>${designer ? `<a class="btn" href="${esc(designer)}" target="_blank" rel="noopener">Designer${EXT}</a>` : ''}`
  });

  const attention = site.monitored
    ? attentionCard(items, 'site', { title: 'Needs attention on this site', clearText: 'Nothing needs attention on this site right now.' })
    : `<section class="card clear" aria-labelledby="att-h">${icon('off')}<div><h2 id="att-h">Monitoring is paused</h2><p>Flowdeck does not check this site while it is paused. ${site.pausedByUser ? 'Turn it back on under Site settings.' : `Your plan monitors up to ${plural(limitOf(user), 'site')}.`}</p><div class="actions" style="margin-top:12px">${site.pausedByUser ? `<a class="btn primary sm" href="#settings">Open site settings</a>` : `<a class="btn primary sm" href="/app/settings#plan">See plans</a>`}</div></div></section>`;

  const [sk, sw] = statusOf(site), [lk, lw] = sslOf(site, now), [pk, pw] = publishOf(site, now), [ek, ew] = seoOf(site);
  const sslX = att.sslState(site, now);
  const cmsX = cmsOf(site);
  const silent = f && f.total30 === 0 && f.before30 > 0;
  const tile = (k, v, s) => `<li class="tile"><span class="tile-k">${k}</span>${v}${s ? `<span class="tile-s">${s}</span>` : ''}</li>`;
  const tiles = `<ul class="tiles" aria-label="Checks at a glance">
${tile('Status', st(sk, sw), `${s7.uptime == null ? 'No checks yet' : s7.uptime + '% in 7 days'}${s30.uptime == null ? '' : ', ' + s30.uptime + '% in 30 days'}${s7.avgMs == null ? '' : '. ' + s7.avgMs + ' ms average'}`)}
${tile('SSL', st(lk, lw), sslX.expiresAt ? `Until ${esc(day(sslX.expiresAt))}` : '')}
${tile('Publishing', st(pk, pw), `Last published ${esc(day(site.lastPublished) || 'never')}`)}
${tile('Forms', f ? (silent ? st('warn', 'Silent 30 days') : `<span class="tile-v">${f.total7} in 7 days</span>`) : st('off', 'Not synced yet'), f ? `${f.total30} in 30 days` : '')}
${tile('CMS', cmsX ? (cmsX.kind ? st(cmsX.kind, att.cmsUsage(site).pct + '% full') : `<span class="tile-v">${cmsX.text} items</span>`) : st('off', 'Not synced yet'), cmsX && cmsX.kind ? `${cms.total} of ${CMS_LIMITS[site.settings.plan]} items` : (cms ? 'Set the site plan to see the limit' : ''))}
${tile('SEO', st(ek, ew), p ? `On ${plural(p.live, 'live page')}` : '')}
</ul>`;

  // Checks tab
  const outs = outages(checks, now - 7 * DAY);
  const uptimeCard = `<article class="card span-all" id="uptime" aria-labelledby="up-h"><div class="card-h"><h3 id="up-h">Uptime, last 7 days</h3><p>${s7.total} checks, ${s7.okCount} passed</p></div>
<p class="legend-t">${BARS_LEGEND}</p>${uptimeBars(checks, now)}
<ul class="facts"><li><b>${s7.uptime == null ? 'No data' : s7.uptime + '%'}</b> in 7 days</li><li><b>${s30.uptime == null ? 'No data' : s30.uptime + '%'}</b> in 30 days</li><li><b>${s7.avgMs == null ? 'No data' : s7.avgMs + ' ms'}</b> average response</li></ul>
${outs.length ? `<p style="margin-top:12px;font-size:13.5px"><b>Failed checks:</b> ${outs.slice(0, 5).map((o) => esc(outageText(o))).join('; ')}${outs.length > 5 ? `; and ${outs.length - 5} more` : ''}.</p>` : ''}
${st0.error ? `<p class="muted small" style="margin-top:6px">Last error: ${esc(st0.error)}</p>` : ''}</article>`;
  const ud = unpublishedDays(site, now);
  const publishCard = `<article class="card" id="publishing" aria-labelledby="pub-h"><div class="card-h"><h3 id="pub-h">Publishing</h3></div><p>${st(pk, pw)}</p>
<dl class="kv" style="margin-top:10px"><div><dt>Last published</dt><dd>${esc(day(site.lastPublished) || 'Never')}</dd></div><div><dt>Last edited</dt><dd>${esc(day(site.lastUpdated) || 'Unknown')}</dd></div></dl>
${ud != null && designer ? `<div class="actions" style="margin-top:12px"><a class="btn sm" href="${esc(designer)}" target="_blank" rel="noopener">Open the Designer${EXT}</a></div>` : ''}</article>`;
  const formsCard = `<article class="card" id="forms" aria-labelledby="forms-h"><div class="card-h"><h3 id="forms-h">Forms, last 30 days</h3>${silent ? st('warn', 'Silent 30 days') : ''}</div>${f ? (f.perForm.length
    ? `<table class="mini"><thead><tr><th scope="col">Form</th><th scope="col" class="num">7 days</th><th scope="col" class="num">30 days</th><th scope="col" class="num">Last</th></tr></thead><tbody>${f.perForm.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${x.count7}</td><td class="num">${x.count30}</td><td class="num">${x.last ? ago(x.last, now) : 'never'}</td></tr>`).join('')}</tbody></table>`
    : `<p class="muted">No submissions in the last 30 days.${silent ? ` There were ${f.before30} in the 30 days before.` : ''}</p>`) : '<p class="muted">Not synced yet.</p>'}</article>`;
  const COLL = 6;
  const collLi = (c) => `<li><span>${esc(c.name)}</span><span>${c.count}</span></li>`;
  const cmsCard = `<article class="card" id="cms" aria-labelledby="cms-h"><div class="card-h"><h3 id="cms-h">CMS</h3>${cmsX && cmsX.kind ? st(cmsX.kind, att.cmsUsage(site).pct + '% full') : ''}</div>${cms
    ? `<p>${cms.total} items across ${plural(cms.collections.length, 'collection')}${CMS_LIMITS[site.settings.plan] ? `, plan limit ${CMS_LIMITS[site.settings.plan]}` : ''}</p><ul class="list">${cms.collections.slice(0, COLL).map(collLi).join('')}</ul>${cms.collections.length > COLL ? `<details class="more"><summary><span class="m-c">Show all ${cms.collections.length}</span><span class="m-o">Show fewer</span></summary><ul class="list">${cms.collections.slice(COLL).map(collLi).join('')}</ul></details>` : ''}`
    : '<p class="muted">Not synced yet.</p>'}</article>`;

  // SEO tab: categories with findings first
  let seoBody = '<p class="muted">Not synced yet.</p>';
  if (p) {
    const groups = [
      ['Missing meta title', p.missingTitle], ['Missing meta description', p.missingDesc], ['Duplicate titles', p.dupTitle, 'dup'],
      ['Title over 60 characters', p.longTitle], ['Description over 160 characters', p.longDesc]
    ];
    const withIssues = groups.filter((g) => g[1].length);
    const clean = groups.filter((g) => !g[1].length);
    seoBody = `${withIssues.map(([label, list, kind]) => `<div class="seo-g"><h4>${esc(label)} ${st('warn', plural(list.length, kind === 'dup' ? 'title' : 'page'))}</h4>${issueList(list, kind, site)}</div>`).join('')}
${clean.length ? `<div class="${withIssues.length ? 'none-list' : 'seo-g'}">${st('ok', withIssues.length ? 'No problems found for:' : 'No problems found')} ${esc(clean.map((g) => g[0].toLowerCase()).join(', '))}.</div>` : ''}`;
  }

  // Client report tab
  const reportBody = reportUrl
    ? `<div class="copy"><label class="vh" for="rlink">Report link</label><input id="rlink" class="mono" type="text" readonly value="${esc(reportUrl)}"><button class="btn sm" type="button" data-copy="rlink" hidden>Copy link</button></div>
<div class="actions"><a class="btn primary" href="${esc(reportUrl)}" target="_blank" rel="noopener">Open report${EXT}</a><form method="post" action="/app/site/report"><input type="hidden" name="id" value="${esc(site.id)}"><input type="hidden" name="action" value="rotate"><button class="btn" type="submit">New link</button></form></div>
<p class="muted small" style="margin-top:10px">New link replaces this one. The old link stops working within a minute.</p>`
    : `<form method="post" action="/app/site/report" style="margin-top:14px"><input type="hidden" name="id" value="${esc(site.id)}"><input type="hidden" name="action" value="create"><button class="btn primary" type="submit">Create report link</button></form>`;

  const PLAN_OPTS = ['unknown', 'basic', 'cms', 'business', 'enterprise'];
  const settingsBody = `<div class="grid2">
<div class="card"><h3>Site settings</h3>
<form method="post" action="/app/site/settings" class="fields" style="margin-top:14px">
<input type="hidden" name="id" value="${esc(site.id)}">
<div class="field"><label for="client">Client name (shown on the report)</label><input type="text" id="client" name="client" value="${esc(site.settings.client)}" placeholder="${esc(site.name)}"></div>
<div class="field"><label for="plan">Webflow site plan (for CMS limits)</label><select id="plan" name="plan">${PLAN_OPTS.map((v) => `<option value="${v}" ${site.settings.plan === v ? 'selected' : ''}>${v === 'unknown' ? 'Not set' : att.PLAN_NAMES[v]}</option>`).join('')}</select></div>
<div class="field"><label for="checkUrl">URL to check (optional)</label><input type="url" id="checkUrl" name="checkUrl" value="${esc(site.settings.checkUrl)}" placeholder="${esc(site.url)}" aria-describedby="checkUrl-hint"><span class="hint" id="checkUrl-hint">Leave empty to check the primary domain. It must be on one of the site's own domains.</span></div>
<label class="check"><input type="checkbox" name="alerts" value="1" ${site.settings.alerts !== false ? 'checked' : ''}> Send alerts for this site</label>
<div class="actions"><button class="btn primary" type="submit">Save</button></div>
</form></div>
<div class="stack">
<div class="card"><div class="card-h"><h3>Monitoring</h3>${site.monitored ? st('ok', 'On') : st('off', 'Paused')}</div>
<form method="post" action="/app/site/monitor"><input type="hidden" name="id" value="${esc(site.id)}"><input type="hidden" name="on" value="${site.monitored ? '0' : '1'}"><button class="btn sm" type="submit">${site.monitored ? 'Pause monitoring' : 'Monitor this site'}</button></form>
<p class="muted small" style="margin-top:8px">${site.monitored ? 'Frees a slot on your plan.' : 'Uses one slot on your plan.'}</p></div>
<div class="card danger-zone"><h3>Remove from Flowdeck</h3><p class="muted small" style="margin:6px 0 12px">Deletes this site's checks, data and report link from Flowdeck. Your Webflow site is not changed.</p>
<form method="post" action="/app/site/remove"><input type="hidden" name="id" value="${esc(site.id)}"><button class="btn sm danger" type="submit">Remove from Flowdeck</button></form></div>
</div></div>`;

  const body = `${noticeBox(notice)}${head}
<div class="stack">${attention}${tiles}</div>
<nav class="tabs" data-tabs data-default="${esc(opts.tab || '')}" aria-label="Site details">
<a href="#checks">Checks</a><a href="#seo">SEO issues${p && p.issues ? ` <span class="tab-n">${p.issues}</span>` : ''}</a><a href="#report">Client report</a><a href="#settings">Site settings</a>
</nav>
<section class="panel" id="checks" aria-label="Checks"><h2 class="panel-h">Checks</h2><div class="stack">${uptimeCard}<div class="grid2">${formsCard}<div class="stack">${publishCard}${cmsCard}</div></div></div></section>
<section class="panel" id="seo" aria-label="SEO issues"><h2 class="panel-h">SEO issues</h2><div class="card"><div class="card-h"><h3>SEO checks${p ? ` on ${plural(p.live, 'live page')}` : ''}</h3><p>Published pages only. Fix them in the page settings in Webflow.</p></div>${seoBody}</div></section>
<section class="panel" id="report" aria-label="Client report"><h2 class="panel-h">Client report</h2><div class="card"><h3>Client report</h3><p class="muted" style="margin-top:6px;max-width:68ch">A white-label page you can send to the client. It shows uptime, forms, publish state and SEO issue counts for the last 30 days. No sign in needed.</p>${reportBody}</div></section>
<section class="panel" id="settings" aria-label="Site settings"><h2 class="panel-h">Site settings</h2>${settingsBody}</section>`;
  return layout(site.name + ' · Flowdeck', body, { user, sites: opts.sites || null, site, now, active: 'site' });
}

/* ---------- client report (public, white-label) ---------- */

function report(user, site, checks, now) {
  now = now || Date.now();
  const f = site.data && site.data.forms;
  const p = site.data && site.data.pages;
  const st0 = site.status || {};
  const s30 = summarizeDaily(st0.daily, now - 30 * DAY); // daily totals for 30 days (single checks are kept 7 days)
  const sslOk = st0.sslExpiresAt && st0.sslExpiresAt > now && !st0.sslError;
  const ssl = !st0.sslExpiresAt ? ['off', 'Not checked'] : st0.sslExpiresAt <= now ? ['bad', 'Expired'] : sslOk ? ['ok', 'Valid'] : ['warn', 'Check'];
  const up = s30.uptime == null ? ['off', 'No data yet'] : [s30.uptime >= 99 ? 'ok' : s30.uptime >= 95 ? 'warn' : 'bad', s30.uptime + '%'];
  const live = unpublishedDays(site, now) == null;
  const brand = (user && user.settings && user.settings.brand) || '';
  const tile = (k, v, s) => `<li class="tile"><span class="tile-k">${k}</span>${v}${s ? `<span class="tile-s">${s}</span>` : ''}</li>`;
  const count = (n) => (n ? st('warn', String(n)) : st('ok', 'None'));
  const outs = outages(checks, now - 7 * DAY);
  const body = `
<div class="ph"><div><p class="muted small">${esc(brand || 'Site report')}</p><h1>${esc(site.settings.client || site.name)}</h1><p class="sub">${esc(site.url)} · last 30 days · ${esc(day(now))}</p></div></div>
<ul class="tiles" aria-label="Summary">
${tile('Uptime', st(up[0], up[1]), 'Share of checks that passed')}
${tile('Response', `<span class="tile-v">${s30.avgMs == null ? 'No data' : s30.avgMs + ' ms'}</span>`, 'Average')}
${tile('Form submissions', `<span class="tile-v">${f ? f.total30 : 'No data'}</span>`, 'In the period')}
${tile('SSL certificate', st(ssl[0], ssl[1]), st0.sslExpiresAt && st0.sslExpiresAt > now ? `Until ${esc(day(st0.sslExpiresAt))}` : '')}
${tile('Publishing', live ? st('ok', 'Everything is live') : st('off', 'Changes waiting'), `Last published ${esc(day(site.lastPublished) || 'never')}`)}
${tile('SEO issues open', p ? count(p.issues) : st('off', 'Not available yet'), '')}
</ul>
<div class="grid2" style="margin-top:20px">
<section class="card span-all" aria-labelledby="av-h"><div class="card-h"><h2 id="av-h">Availability</h2></div><p class="legend-t">${BARS_LEGEND}</p>${uptimeBars(checks, now)}<p class="muted small" style="margin-top:10px">${s30.total} checks in the period, ${s30.okCount} successful. Checked every 5 minutes; the bars show the last 7 days.</p>${outs.length ? `<p class="small" style="margin-top:6px">Failed checks in the last 7 days: ${outs.slice(0, 5).map((o) => esc(outageText(o))).join('; ')}${outs.length > 5 ? `; and ${outs.length - 5} more` : ''}.</p>` : ''}</section>
<section class="card" aria-labelledby="fo-h"><div class="card-h"><h2 id="fo-h">Forms</h2></div>${f && f.perForm.length ? `<ul class="list">${f.perForm.map((x) => `<li><span>${esc(x.name)}</span><span>${x.count30} submissions</span></li>`).join('')}</ul>` : '<p class="muted">No submissions in the period.</p>'}</section>
<section class="card" aria-labelledby="pu-h"><div class="card-h"><h2 id="pu-h">Publishing</h2></div><p>${live ? st('ok', 'Everything is live') : st('off', 'Changes waiting')}</p><p style="margin-top:8px">Last published ${esc(day(site.lastPublished) || 'never')}.${live ? '' : ' Some changes are waiting to be published.'}</p></section>
<section class="card" aria-labelledby="se-h"><div class="card-h"><h2 id="se-h">SEO health</h2></div>${p ? `<dl class="kv"><div><dt>Pages checked</dt><dd>${p.live}</dd></div><div><dt>Missing titles</dt><dd>${count(p.missingTitle.length)}</dd></div><div><dt>Missing descriptions</dt><dd>${count(p.missingDesc.length)}</dd></div><div><dt>Duplicate titles</dt><dd>${count(p.dupTitle.length)}</dd></div></dl>` : '<p class="muted">Not available yet.</p>'}</section>
</div>
<p class="muted small" style="margin-top:18px">${esc(brand ? 'Prepared by ' + brand : 'Prepared with Flowdeck')}.</p>`;
  return layout((site.settings.client || site.name) + ' report', body, { plain: true });
}

/* ---------- settings ---------- */

function planPanel(user, sites, limit, opts) {
  const monitored = sites.filter((s) => s.monitored).length;
  const b = user.billing || {};
  const paid = user.plan && user.plan !== 'free';
  const current = `<p>You are on <strong>${esc(paid && PLANS[user.plan] ? PLANS[user.plan].name : 'Free')}</strong>: ${monitored} of ${limit} site${limit === 1 ? '' : 's'} monitored, ${sites.length} connected.</p>`;
  const status = paid ? `<p class="muted small" style="margin-top:6px">${b.status === 'cancelled' && b.endsAt ? 'Cancelled, active until ' + esc(day(b.endsAt)) : b.renewsAt ? 'Renews ' + esc(day(b.renewsAt)) : ''}${b.status === 'past_due' ? ' · payment failed, please update your card' : ''}</p>` : '';
  const rows = Object.keys(PLANS).map((k) => {
    const p = PLANS[k];
    const isCurrent = user.plan === k;
    const buttons = isCurrent ? st('ok', 'Current plan')
      : opts.billing && !paid ? `<form method="post" action="/app/billing/checkout"><input type="hidden" name="plan" value="${k}"><input type="hidden" name="interval" value="monthly"><button class="btn sm${k === 'studio' ? ' primary' : ''}" type="submit">$${p.monthly}/mo</button></form><form method="post" action="/app/billing/checkout"><input type="hidden" name="plan" value="${k}"><input type="hidden" name="interval" value="yearly"><button class="btn sm" type="submit">$${p.yearly}/yr</button></form>`
        : `<span class="muted small">$${p.monthly}/mo</span>`;
    return `<li${isCurrent ? ' class="cur"' : ''}><span><strong>${p.name}</strong> · ${p.sites} sites</span><span class="pr">${buttons}</span></li>`;
  }).join('');
  const manage = paid && b.subscriptionId ? `<div class="actions" style="margin-top:14px"><a class="btn" href="/app/billing/portal">Manage billing, invoices or cancel</a></div>` : '';
  const note = paid ? '<p class="muted small" style="margin-top:12px">To change plans, use Manage billing. Need more than 40 sites? Write to info@silitlabs.com.</p>'
    : `<p class="muted small" style="margin-top:12px">${opts.billing ? `Yearly plans include two months free. Payments are handled by ${esc(opts.providerName || 'Lemon Squeezy')}; cancel any time.` : 'Paid plans are opening shortly.'} Need more than 40 sites? Write to info@silitlabs.com.</p>`;
  const free = !user.plan || user.plan === 'free';
  return `<div class="card"><div class="card-h"><h3>Plan</h3></div>${current}${status}
<span class="meter" style="margin-top:12px" aria-hidden="true"><i style="width:${Math.min(100, Math.round((monitored / Math.max(1, limit)) * 100))}%"></i></span>
<ul class="plans"><li${free ? ' class="cur"' : ''}><span><strong>Free</strong> · 1 site</span><span class="pr">${free ? st('ok', 'Current plan') : ''}</span></li>${rows}</ul>${manage}${note}</div>`;
}

function settings(user, sites, notice, opts) {
  opts = opts || {};
  const now = Date.now();
  const limit = limitOf(user);
  const b = user.billing || {};
  const paid = user.plan && user.plan !== 'free';
  const over = sites.filter((s) => !s.monitored && !s.pausedByUser).length;
  const items = [];
  if (paid && b.status === 'past_due') items.push({ sev: 'bad', title: 'Your last payment failed', detail: `Update your card so the ${planName(user)} plan stays active.`, action: { href: '/app/billing/portal', label: 'Update your card' } });
  if (over) items.push({ sev: 'warn', title: `${plural(over, 'site')} not monitored`, detail: `Your ${planName(user)} plan monitors up to ${plural(limit, 'site')}. Upgrade to monitor the rest.`, action: { href: '#plan', label: 'See plans' } });
  if (user.settings.alerts === false) items.push({ sev: 'warn', title: 'Alert emails are off', detail: 'You will not get an email when a site goes down. Turn them on under Alerts and reports.', action: { href: '#alerts', label: 'Turn alerts on' } });

  const body = `${noticeBox(notice)}${pageHead({ title: 'Settings', sub: 'Signed in as ' + esc(user.email) })}
${items.length ? attentionCard(items, 'settings', { title: 'Needs attention' }) : ''}
<nav class="tabs" data-tabs data-default="${esc(opts.tab || '')}" aria-label="Settings sections">
<a href="#alerts">Alerts and reports</a><a href="#plan">Plan</a><a href="#connections">Webflow connections</a><a href="#account">Account</a>
</nav>
<section class="panel" id="alerts" aria-label="Alerts and reports"><h2 class="panel-h">Alerts and reports</h2><div class="card" style="max-width:680px"><h3>Alerts and reports</h3>
<form method="post" action="/app/settings" class="fields" style="margin-top:14px">
<div class="field"><label for="alertEmail">Send alerts and the weekly report to</label><input type="email" id="alertEmail" name="alertEmail" value="${esc(user.settings.alertEmail || user.email)}"></div>
<div class="field"><label for="brand">Agency name (shown on client reports)</label><input type="text" id="brand" name="brand" value="${esc(user.settings.brand)}" placeholder="Your studio"></div>
<label class="check"><input type="checkbox" name="alerts" value="1" ${user.settings.alerts !== false ? 'checked' : ''}> Email me when a site goes down, SSL is about to expire, changes sit unpublished for 7 days, or a form goes silent</label>
<label class="check"><input type="checkbox" name="digest" value="1" ${user.settings.digest !== false ? 'checked' : ''}> Weekly summary every Monday</label>
<div class="actions"><button class="btn primary" type="submit">Save</button></div>
</form></div></section>
<section class="panel" id="plan" aria-label="Plan"><h2 class="panel-h">Plan</h2><div style="max-width:680px">${planPanel(user, sites, limit, opts)}</div></section>
<section class="panel" id="connections" aria-label="Webflow connections"><h2 class="panel-h">Webflow connections</h2><div class="card" style="max-width:680px"><h3>Webflow connections</h3><p class="muted small" style="margin-top:6px">Each connection is one Webflow authorization. Disconnect revokes Flowdeck's access in Webflow and deletes the stored token and that connection's sites from Flowdeck. Uninstalling the app in Webflow has the same effect, usually within an hour.</p>
<ul class="conns">${user.connections.map((c) => `<li><span>${esc(c.label || 'Connection')} <span class="muted">authorized ${esc(day(c.authorizedAt))}, ${plural(sites.filter((s) => s.connectionId === c.id).length, 'site')}</span></span><form method="post" action="/app/connection/remove"><input type="hidden" name="id" value="${esc(c.id)}"><button class="btn sm" type="submit">Disconnect</button></form></li>`).join('') || '<li class="muted">None yet</li>'}</ul>
<div class="actions" style="margin-top:14px"><a class="btn" href="/auth">${icon('n-plus')}Connect more sites</a></div></div></section>
<section class="panel" id="account" aria-label="Account"><h2 class="panel-h">Account</h2><div class="stack" style="max-width:680px">
<div class="card"><h3>Your account</h3><dl class="kv" style="margin-top:10px"><div><dt>Email</dt><dd>${esc(user.email)}</dd></div></dl><div class="actions" style="margin-top:12px"><a class="btn sm" href="/logout">Sign out</a></div><p class="muted small" style="margin-top:8px">Signing out does not remove Webflow access.</p></div>
<div class="card danger-zone"><h3>Delete account</h3><p class="muted small" style="margin:6px 0 12px">Revokes every Webflow authorization and removes your sites, checks and tokens from Flowdeck. Your Webflow sites are not affected.</p>
<form method="post" action="/app/delete"><button class="btn sm danger" type="submit">Delete my Flowdeck account</button></form></div>
</div></section>`;
  return layout('Settings · Flowdeck', body, { user, sites, now, active: 'settings' });
}

module.exports = { layout, errorPage, dashboard, siteDetail, report, settings, loginPage, loginConfirm, esc, ago, fmtDate };
