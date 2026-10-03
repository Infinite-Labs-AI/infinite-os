"use client"

import posthog from "posthog-js"
import { useEffect } from "react"

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init("phc_FAKEtestProjectKeyNotReal000", { api_host: "https://us.i.posthog.com" })
  }, [])
  return <>{children}</>
}
