# Flowdeck: source for Marketplace review

Flowdeck is a Data Client app (no Designer Extension). It runs as one Node.js serverless function on Vercel and ships this source unchanged: there is no build step, no bundler and no transpiling, so there are no source maps. `package.json` and `package-lock.json` are included; the only dependency is a dev dependency used to draw the logo.

- Live app: https://flowdeck.silitlabs.com
- Install link (Marketplace): https://webflow.com/oauth/authorize?response_type=code&client_id=a2bf2dbad02033581d75ec35cadf0663c6b4cfdfb659598e41af62ccbbc97ea2&scope=authorized_user%3Aread+sites%3Aread+pages%3Aread+cms%3Aread+forms%3Aread
- Redirect URI: https://flowdeck.silitlabs.com/callback
- Scopes (read only): authorized_user:read, sites:read, pages:read, cms:read, forms:read
- Testing site: https://flowdeck-demo.webflow.io
- Support: info@silitlabs.com

## Files

```
api/index.js           all routes: /auth, /callback, dashboard pages, client report /r/{token}, /cron/*
api/_lib/webflow.js    Webflow Data API v2 client and OAuth token exchange
api/_lib/store.js      Redis data access (users, sites, uptime history, alert state)
api/_lib/sync.js       reads page SEO fields, form submission dates and CMS item counts
api/_lib/checks.js     HTTP uptime and TLS certificate checks against the published site
api/_lib/alerts.js     alert rules (down, SSL, unpublished changes, silent forms)
api/_lib/jobs.js       scheduled jobs: checks every 5 min, sync every 15 min, weekly digest
api/_lib/crypto.js     encrypts the stored OAuth token and the session cookie
api/_lib/billing.js    Lemon Squeezy checkout and plan limits
api/billing-webhook.mjs  Lemon Squeezy webhook
public/                landing, docs, privacy, terms
test/app.js            end to end test with mock Webflow, Redis, email and customer sites (node test/app.js)
vercel.json            routes and function settings
```

## Fix in this version (review ticket #1213611)

Reported: accepting the Webflow OAuth request redirected to an error page.

Cause: the Marketplace install link has no `redirect_uri`, but the token request always sent one, so Webflow rejected the code exchange. Sign in from our own site worked, which is why the problem did not show in our tests.

Fix:
- The token request now sends `redirect_uri` only when the authorization link had one (our own sign in link adds `state` and `redirect_uri`; the install link has neither). If Webflow rejects that form, the other form is tried once.
- The first data load after authorization runs inside a 12 second budget so a workspace with many large sites cannot make the sign in time out; scheduled jobs load the rest within minutes.
- Route handlers are awaited, so any error shows a clear page instead of a platform error; sign in errors are logged.
- The end to end test now covers the Marketplace install flow (callback with no `state` and no `redirect_uri`): 51 checks pass.

## How to test

1. Open the install link above and authorize one or more sites.
2. You land on the Flowdeck dashboard with the sites listed; uptime appears within 5 minutes, "Refresh data" loads forms, CMS and SEO data at once.
3. Open a site for uptime bars, form counts per form, CMS collections and SEO issues; "Client report" creates a shareable page.
4. Settings: alert email, weekly summary, connected Webflow accounts, delete account.

The free plan monitors 1 site with every feature. To review with more sites, write to info@silitlabs.com and we raise the limit at no cost.
