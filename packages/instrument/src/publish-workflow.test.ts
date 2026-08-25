import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

describe("publish workflow", () => {
  it("publishes the exact npm 11 tarball validated from its JSON receipt", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/publish.yml"), "utf8")

    expect(workflow).toContain('receipt="${RUNNER_TEMP}/infinite-tag-pack.json"')
    expect(workflow).toContain("run: npm install -g npm@11")
    expect(workflow).not.toContain("npm@latest")
    expect(workflow).toContain('npm pack --json > "${receipt}"')
    expect(workflow).toContain(
      'tgz="$(node ../../scripts/ci/validate-infinite-tag-pack.mjs "${receipt}")"'
    )
    expect(workflow).toContain('sha256="$(sha256sum "${tgz}" | cut -d \' \' -f 1)"')
    expect(workflow).toContain('printf \'tarball=%s\\n\' "${tgz}" >> "${GITHUB_OUTPUT}"')
    expect(workflow).toContain(
      'npm publish "${{ steps.pack.outputs.tarball }}" --access public'
    )
    expect(workflow).not.toContain("contracts/**")
    expect(workflow).not.toContain("inspect-infinite-tag-tarball")

    const validationIndex = workflow.indexOf("validate-infinite-tag-pack.mjs")
    const publishIndex = workflow.indexOf(
      'npm publish "${{ steps.pack.outputs.tarball }}" --access public'
    )
    expect(validationIndex).toBeGreaterThan(-1)
    expect(publishIndex).toBeGreaterThan(validationIndex)
    expect(workflow.slice(validationIndex, publishIndex)).not.toMatch(
      /npm pack|prepack|pnpm|run build/
    )

    expect(workflow).toContain("permissions:\n  contents: read\n  id-token: write")
    expect(workflow).toContain("if: ${{ !inputs.dry-run }}")
  })
})
