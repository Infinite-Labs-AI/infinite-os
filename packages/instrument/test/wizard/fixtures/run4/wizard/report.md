**shop.examplebrand.com does not collect properly yet: 1 problem on the live site (spa page views) · 1 approved fix is not in the code (Improve the existing Meta pixel)**

- Problems on the live site: spa page views
- Approved fixes the wizard has not confirmed in the code: Improve the existing Meta pixel
- Sending, but its ID is not checked (not connected in Infinite): Meta 777700...2222
- Problems found before the merge and not re-checked after the deploy: survives ad blockers

### Before and after · shop.examplebrand.com

| | Live site today | In this pull request | Proven live |
|---|---|---|---|
| Checks passing | 3 pass · 4 problems · 2 unknown · 5 not testable of 14 (problem) | 5 pass · 0 problems · 4 unknown · 5 not testable of 14 (unknown) | 7 pass · 1 problem · 5 unknown · 1 not testable of 14 (problem) |
| GA4 page views per visit | 1 | 1 | 1 · sent (seen leaving) |
| PostHog route | — | not installed | — |
| Meta pixel | — | — | sending (seen leaving) · ID not checked: not connected in Infinite |
| Page views from preview links | — | guard added · the preview link sent nothing | — |
| Conversions sent from the server | 0 in 7 days (problem) | — | — |
| GA4 key events | — | — | — |
| Consent setting | collect by default | "collect by default" recorded | collect by default |
| Live test per tool | 1 of 2 tools fire once (nothing sent) | rehearsal: 2 of 3 tools fire once, right ID (nothing sent) (unknown) | 3 of 3 fire: 1 verified (receipts from this visit) · 2 seen leaving |

**7 days later:** — (measured again 7 days after the deploy)

<details><summary>The 14 checks</summary>

| # | Check | Live site today | In this pull request | Proven live |
|---|---|---|---|---|
| 1 | each tool once | GA4 set up 2 times (problem) | — | Infinite pixel: fires once |
| 2 | ids match connections | problem | — | Meta: ID not checked: not connected in Infinite (unknown) |
| 3 | previews silent | — | preview link sent nothing | GA4: silent on the merge's own deployment address |
| 4 | survives ad blockers | server lane not receiving (problem) | — | — |
| 5 | spa page views | no page change observed (unknown) | one page view per navigation | GA4: misses page changes (problem) |
| 6 | conversions server side | 0 sent from the server in 7 days (problem) | — | — |
| 7 | identity joined | no login found | — | — |
| 8 | utms survive redirects | pass | — | campaign tags kept through every redirect |
| 9 | consent recorded | collect by default | "collect by default" recorded | collect by default |
| 10 | csp allows | unknown | no CSP violation | no CSP violation |
| 11 | ga4 key events received | — | — | — |
| 12 | no pii | no personal data in any request | — | no personal data in any request |
| 13 | proof from real visit | — | — | Infinite pixel: receipt for this visit |
| 14 | keeps being checked | — | 7-day check-in is on | 7-day check-in on 10 Oct (pending) |

</details>

This run's one real visit landed 1 row in your Infinite ledger, marked as Infinite's test and kept out of your numbers: the page view.  
GA4 and Meta each record it as one normal page view (filter it by: GA4 client id 1505848303.1791061694 · Meta PageView at 21:08:17Z).  
Review finding on the wizard's own change: R4 app/layout.tsx:59 (should)  
Claude Code ran claude-opus-4-8 at xhigh effort.  
— / pending: the tool is not connected in Infinite  
— / pending: measured again 7 days after the deploy  
— / pending: Infinite could not read it this time  
— / pending: this run did not exercise it  
