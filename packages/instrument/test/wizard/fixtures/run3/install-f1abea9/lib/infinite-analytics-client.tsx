"use client"

// Managed by Infinite. Public install artifacts only.

import { useEffect } from "react"
import { installInfiniteInstrumentation } from "./infinite-analytics"

export function InfiniteAnalyticsClient(): null {
  useEffect(() => {
    installInfiniteInstrumentation()
  }, [])

  return null
}
