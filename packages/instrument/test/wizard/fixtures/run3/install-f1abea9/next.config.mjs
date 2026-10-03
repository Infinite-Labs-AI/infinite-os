// Managed by Infinite. Public install artifacts only.

export default {
  async rewrites() {
    return [
      { source: "/infinite/ledger", destination: "https://api.ultima.inc/api/analytics/events/collect" }
    ]
  }
}
