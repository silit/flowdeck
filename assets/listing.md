# Webflow Marketplace listing (copy-paste material)

Submission form: https://developers.webflow.com/submit

## App name (max 30)
Flowdeck

## Short description (max 100 characters)
One dashboard for every Webflow site you manage: uptime, SSL, forms, publish state, SEO, client reports.

## Long description (markdown, no links)
**Flowdeck watches all the Webflow sites you manage and tells you before the client does.**

Agencies and freelancers run ten, thirty, a hundred Webflow sites. Nobody opens each one every morning. Flowdeck does, and puts the answers on one screen.

**What it checks**
- Uptime and response time, every 5 minutes, from outside Webflow
- SSL certificate expiry for every custom domain
- Designer changes that have sat unpublished for more than 7 days
- Form submissions per form for the last 7 and 30 days, and forms that went quiet
- CMS item counts against the site plan limit
- Missing or duplicate meta titles, missing descriptions, overlong titles and descriptions

**What it sends**
- An email when a site goes down and another when it is back
- Warnings for SSL expiry, unpublished changes and silent forms, once per problem
- A weekly summary every Monday with every site in one table
- A white-label client report page per site, with your agency name, that you can send as a link

**Good to know**
- Read-only access. Flowdeck never writes to your sites.
- Connect sites from any number of workspaces; connect once per workspace.
- Submission counts only; the content of form submissions is never read or stored.
- Delete your account from Settings and all data goes with it.

Free for up to 25 sites. Not affiliated with Webflow.

## Feature list (up to 5)
1. Uptime and SSL monitoring for every site, every 5 minutes
2. Unpublished-changes, silent-form and CMS-limit warnings
3. Form submission counts for 7 and 30 days, per form
4. Page-level SEO checks: missing and duplicate titles, descriptions, lengths
5. Weekly summary email and white-label client report links

## Categories (up to 5)
Analytics, SEO, Utilities, Marketing, Automation

## URLs
- Website: https://flowdeck.silitlabs.com
- Privacy policy: https://flowdeck.silitlabs.com/privacy
- Terms of service: https://flowdeck.silitlabs.com/terms
- Support email: info@silitlabs.com

## Logo
assets/logo-900.png (900x900 PNG). Upload name: flowdeck-logo.png

## Screenshots (3 to 5, 1280x846)
1. Dashboard with several sites, one Down and one Unpublished flag
2. Site detail with the uptime bars, forms table and SEO issues
3. Client report page
4. Settings page with alert options
5. The weekly summary email

## Review notes
Free app for up to 25 sites, no in-app purchases. Data Client app with read-only scopes (authorized_user:read, sites:read, pages:read, cms:read, forms:read). The app reads site metadata, page SEO fields, form submission dates and CMS item counts, stores the OAuth token encrypted for scheduled checks, and performs HTTP uptime checks against the published site. It never writes to a site. To test: sign in, allow one or more sites, open the dashboard; uptime appears within 5 minutes; use Refresh data for forms, CMS and SEO; Settings lets you delete the account. If the user denies access on the Webflow consent screen, Flowdeck shows an "Authorization cancelled" page with a link back to the start; nothing is stored.

## Scopes to request in the app settings
authorized_user:read, sites:read, pages:read, cms:read, forms:read

## Redirect URI
https://flowdeck.silitlabs.com/callback

## Install URL (Data Client, direct to Webflow OAuth)
https://webflow.com/oauth/authorize?response_type=code&client_id=a2bf2dbad02033581d75ec35cadf0663c6b4cfdfb659598e41af62ccbbc97ea2&scope=authorized_user%3Aread+sites%3Aread+pages%3Aread+cms%3Aread+forms%3Aread

## Screenshot alt text
1. Flowdeck dashboard listing six Webflow sites with uptime, SSL, publish state, form counts, CMS usage and SEO flags; one site marked Down
2. Site detail page with 7-day uptime bars, per-form submission table, CMS collections and SEO issues by page
3. White-label client report showing the agency name, 30-day uptime, form submissions and SEO health for one site
4. Settings page with alert email, agency name, alert and weekly summary options and the connected Webflow accounts
5. Weekly summary email listing every site with uptime, submissions, SEO issues and flags
