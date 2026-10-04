**infinite-tag: what happened**

Reviewed by Codex (incomplete: R15 not checked). A review is an opinion; only a receipt from this run means "proven".

**shop.examplebrand.com: set up in the pull request · not checked live yet (nothing in Infinite can finish it: run npx infinite-tag again once it is live)**

- Approved fixes the wizard has not confirmed in the code: Improve the existing Meta pixel

### Before and after · shop.examplebrand.com

| | Live site today | In this pull request | Proven live |
|---|---|---|---|
| Checks passing | 3 pass · 4 problems · 2 unknown · 5 not testable of 14 (problem) | 5 pass · 0 problems · 4 unknown · 5 not testable of 14 (unknown) | — |
| GA4 page views per visit | 1 | 1 | — |
| PostHog route | — | not installed | — |
| Meta pixel | — | — | — |
| Page views from preview links | — | guard added · the preview link sent nothing | — |
| Conversions sent from the server | 0 in 7 days (problem) | — | — |
| GA4 key events | — | — | — |
| Consent setting | collect by default | "collect by default" recorded | — |
| Live test per tool | 1 of 2 tools fire once (nothing sent) | rehearsal: 2 of 3 tools fire once, right ID (nothing sent) (unknown) | — |

**7 days later:** — (measured again 7 days after the deploy)

<details><summary>The 14 checks</summary>

| # | Check | Live site today | In this pull request | Proven live |
|---|---|---|---|---|
| 1 | each tool once | GA4 set up 2 times (problem) | — | — |
| 2 | ids match connections | problem | — | — |
| 3 | previews silent | — | preview link sent nothing | — |
| 4 | survives ad blockers | server lane not receiving (problem) | — | — |
| 5 | spa page views | no page change observed (unknown) | one page view per navigation | — |
| 6 | conversions server side | 0 sent from the server in 7 days (problem) | — | — |
| 7 | identity joined | no login found | — | — |
| 8 | utms survive redirects | pass | — | — |
| 9 | consent recorded | collect by default | "collect by default" recorded | — |
| 10 | csp allows | unknown | no CSP violation | — |
| 11 | ga4 key events received | — | — | — |
| 12 | no pii | no personal data in any request | — | — |
| 13 | proof from real visit | — | — | — |
| 14 | keeps being checked | — | 7-day check-in is on | — |

</details>

— / pending: the tool is not connected in Infinite  
— / pending: measured again 7 days after the deploy  
— / pending: Infinite could not read it this time  
— / pending: this run did not exercise it

**Checklist (the wizard's own checks, never the agent's word)**

| Job | State |
|---|---|
| Remove duplicate tags | waiting deploy |
| Keep previews silent: GA4 | proven |
| Keep previews silent: Meta pixel | done in code |
| Send the signup conversion to every tool | waiting real event |
| Improve the existing Meta pixel | blocked: The agent ran out of time; its edits were undone. |

**Declined, with reasons**

- `app/layout.tsx`: Not changed: the wizard's own checks preview_self_silent, adopted_init_guarded passed on this commit, and its checks outrank a reviewer's opinion.

> Review finding on the wizard's own change: R4 app/layout.tsx:59 (should)

> Round 1: Not fixed: the agent ran out of its 5 minutes before changing anything. It stays open.

Merge when you're happy. After it deploys, Infinite proves it live.

<!-- infinite-tag:final v1 run=85483904-c9a1-4125-bb85-8fd66e709247 -->
