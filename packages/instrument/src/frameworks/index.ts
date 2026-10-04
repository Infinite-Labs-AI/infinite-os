import type { FrameworkAdapter, SupportedFramework } from "../types.js"

import { nextAppRouterAdapter } from "./next-app-router.js"
import { nextPagesRouterAdapter } from "./next-pages-router.js"
import { staticHtmlAdapter } from "./static-html.js"
import { viteReactAdapter } from "./vite-react.js"

export const frameworkAdapters: FrameworkAdapter[] = [
  nextAppRouterAdapter,
  nextPagesRouterAdapter,
  viteReactAdapter,
  staticHtmlAdapter
]

export function getFrameworkAdapter(
  framework: string
): FrameworkAdapter | undefined {
  return frameworkAdapters.find((adapter) => adapter.id === framework)
}

export function isSupportedFramework(framework: string): framework is SupportedFramework {
  return frameworkAdapters.some((adapter) => adapter.id === framework)
}
