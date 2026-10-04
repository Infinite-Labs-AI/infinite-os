# example-shop-site

A throwaway test site for running `npx infinite-tag` end to end. It is not a real product.

It is a small Next.js App Router site shaped like a customer site: a home page with a "Start free
trial" button, `/pricing`, `/signup` (an API route "creates" a user in memory, no database),
`/login`, and a logout. Its GA4 tag uses the fake ID `G-TEST0000000` and is configured twice on
purpose, so the wizard has a real problem to find (GA4 counts every page view twice).

```bash
npm install
npm run dev     # local
npm run build   # what Vercel runs
```

Hosted on Vercel; every pull request gets a preview deployment.
