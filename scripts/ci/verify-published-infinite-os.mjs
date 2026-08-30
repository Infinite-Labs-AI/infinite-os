#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "infinite-os";
const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const REPOSITORY_URL = "https://github.com/Infinite-Labs-AI/infinite-os";
const PUBLISH_WORKFLOW_PATH = ".github/workflows/publish-infinite-os.yml";
const EXPECTED_INSTALLER_URL = "DOWNLOAD_URL=\"https://infinite.fast/download\"";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const validator = join(repoRoot, "scripts", "ci", "validate-infinite-os-pack.mjs");

function reject(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function semverParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) reject(`latest is not a stable SemVer version: ${String(version)}`);
  return match.slice(1).map((part) => Number(part));
}

function compareSemver(a, b) {
  const left = semverParts(a);
  const right = semverParts(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) reject(`GET ${url} failed with ${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { accept: "text/plain" }
  });
  if (!response.ok) reject(`GET ${url} failed with ${response.status}`);
  return response.text();
}

function integrityHex(integrity) {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!match) reject(`unexpected integrity format: ${JSON.stringify(integrity)}`);
  return Buffer.from(match[1], "base64").toString("hex");
}

function decodePayload(attestation) {
  const payload = attestation?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string" || payload.length === 0) {
    reject(`attestation ${String(attestation?.predicateType)} has no DSSE payload`);
  }
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

function subjectDigest(statement, version) {
  const subject = statement.subject;
  if (!Array.isArray(subject) || subject.length !== 1) {
    reject("attestation subject must contain exactly one package");
  }
  const entry = subject[0];
  if (!isRecord(entry) || entry.name !== `pkg:npm/${PACKAGE_NAME}@${version}`) {
    reject(`unexpected attestation subject: ${JSON.stringify(entry)}`);
  }
  const digest = entry.digest;
  if (!isRecord(digest) || typeof digest.sha512 !== "string") {
    reject("attestation subject is missing sha512 digest");
  }
  return digest.sha512;
}

function validateLatestVersion(packument) {
  const latest = packument?.["dist-tags"]?.latest;
  if (typeof latest !== "string") reject("registry packument has no latest tag");
  semverParts(latest);

  const versions = isRecord(packument.versions) ? Object.keys(packument.versions) : [];
  const stable = versions.filter((version) => /^\d+\.\d+\.\d+$/.test(version));
  const greatest = stable.sort(compareSemver).at(-1);
  if (greatest !== latest) {
    reject(`latest ${latest} is not the greatest stable published version ${greatest}`);
  }
  return latest;
}

function validateRegistryMetadata(metadata, version) {
  if (!isRecord(metadata) || metadata.name !== PACKAGE_NAME || metadata.version !== version) {
    reject(`unexpected registry metadata for ${PACKAGE_NAME}@${version}`);
  }
  if (metadata._npmUser?.trustedPublisher?.id !== "github") {
    reject("published package was not created through npm trusted publishing");
  }
  if (metadata._npmUser?.name !== "GitHub Actions") {
    reject("published package user is not GitHub Actions");
  }
  if (metadata.repository?.url !== "git+https://github.com/Infinite-Labs-AI/infinite-os.git") {
    reject("published package repository URL changed");
  }
  if (metadata.repository?.directory !== "packages/desktop-installer") {
    reject("published package repository directory changed");
  }
  if (metadata.dist?.fileCount !== 5) reject("published package file count is not five");
  if (typeof metadata.dist?.tarball !== "string") reject("published package has no tarball URL");
  if (typeof metadata.dist?.integrity !== "string") reject("published package has no integrity");
  if (!Array.isArray(metadata.dist?.signatures) || metadata.dist.signatures.length === 0) {
    reject("published package has no registry signatures");
  }
  if (metadata.dist?.attestations?.provenance?.predicateType !== "https://slsa.dev/provenance/v1") {
    reject("published package has no SLSA provenance declaration");
  }
  if (typeof metadata.dist?.attestations?.url !== "string") {
    reject("published package has no attestation URL");
  }
}

function validateAttestations(attestationsResponse, metadata, version) {
  const attestations = attestationsResponse?.attestations;
  if (!Array.isArray(attestations)) reject("attestation response has no attestations array");

  const publish = attestations.find(
    (entry) =>
      entry?.predicateType ===
      "https://github.com/npm/attestation/tree/main/specs/publish/v0.1"
  );
  const slsa = attestations.find(
    (entry) => entry?.predicateType === "https://slsa.dev/provenance/v1"
  );
  if (!publish) reject("npm publish attestation is missing");
  if (!slsa) reject("SLSA provenance attestation is missing");

  const expectedDigest = integrityHex(metadata.dist.integrity);
  const publishStatement = decodePayload(publish);
  const slsaStatement = decodePayload(slsa);
  if (subjectDigest(publishStatement, version) !== expectedDigest) {
    reject("npm publish attestation digest does not match registry integrity");
  }
  if (subjectDigest(slsaStatement, version) !== expectedDigest) {
    reject("SLSA attestation digest does not match registry integrity");
  }
  if (publishStatement.predicate?.name !== PACKAGE_NAME) {
    reject("npm publish attestation package name changed");
  }
  if (publishStatement.predicate?.version !== version) {
    reject("npm publish attestation package version changed");
  }
  if (publishStatement.predicate?.registry !== REGISTRY_ORIGIN) {
    reject("npm publish attestation registry changed");
  }

  const buildDefinition = slsaStatement.predicate?.buildDefinition;
  const workflow = buildDefinition?.externalParameters?.workflow;
  if (buildDefinition?.buildType !== "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1") {
    reject("SLSA build type is not GitHub Actions workflow provenance");
  }
  if (workflow?.repository !== REPOSITORY_URL) reject("SLSA workflow repository changed");
  if (workflow?.path !== PUBLISH_WORKFLOW_PATH) reject("SLSA workflow path changed");
  if (workflow?.ref !== "refs/heads/main") reject("SLSA workflow ref is not main");
  if (slsaStatement.predicate?.runDetails?.builder?.id !== "https://github.com/actions/runner/github-hosted") {
    reject("SLSA builder is not the GitHub-hosted runner");
  }

  const dependency = buildDefinition?.resolvedDependencies?.find(
    (entry) => entry?.uri === `git+${REPOSITORY_URL}@refs/heads/main`
  );
  const sourceCommit = dependency?.digest?.gitCommit;
  if (typeof sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
    reject("SLSA provenance did not resolve a 40-character source commit");
  }
  return sourceCommit;
}

function runNpmSignatureAudit(version) {
  const audit = spawnSync("npm", ["audit", "signatures", `${PACKAGE_NAME}@${version}`, "--json"], {
    encoding: "utf8",
    timeout: 120_000
  });
  if (audit.status !== 0) {
    reject(`npm audit signatures failed:\n${audit.stderr || audit.stdout}`);
  }
  const parsed = JSON.parse(audit.stdout || "{}");
  if ((parsed.invalid?.length ?? 0) !== 0 || (parsed.missing?.length ?? 0) !== 0) {
    reject(`npm registry signatures are not clean: ${audit.stdout}`);
  }
}

function validateInstallerVersion(installer, version) {
  const literalUserAgent = `INSTALLER_USER_AGENT="Infinite-Installer/${version}"`;
  const derivedUserAgent =
    installer.includes(`INSTALLER_VERSION="${version}"`) &&
    installer.includes('INSTALLER_USER_AGENT="Infinite-Installer/${INSTALLER_VERSION}"');
  if (!installer.includes(literalUserAgent) && !derivedUserAgent) {
    reject("installer User-Agent does not match the registry package version");
  }
}

function validateInstallerHelp(installerPath) {
  const help = execFileSync("/bin/bash", [installerPath, "--help"], {
    encoding: "utf8",
    timeout: 30_000
  });
  if (!help.includes("Infinite for macOS installer")) {
    reject("installer --help did not render expected help");
  }
}

function validateBinHelp(binPath) {
  const help = execFileSync(process.execPath, [binPath, "--help"], {
    encoding: "utf8",
    timeout: 30_000
  });
  if (!help.includes("Infinite for macOS installer")) {
    reject("package bin --help did not render expected help");
  }
}

function packAndValidate(version, expectedIntegrity) {
  const tempRoot = mkdtempSync(join(tmpdir(), "infinite-os-published-"));
  try {
    const receiptText = execFileSync(
      "npm",
      ["pack", `${PACKAGE_NAME}@${version}`, "--json", "--pack-destination", tempRoot],
      { encoding: "utf8", timeout: 120_000 }
    );
    const receiptPath = join(tempRoot, "receipt.json");
    writeFileSync(receiptPath, receiptText);
    const tarballName = execFileSync(process.execPath, [validator, receiptPath], {
      encoding: "utf8",
      timeout: 30_000
    }).trim();
    const tarballPath = join(tempRoot, tarballName);
    if (!existsSync(tarballPath)) reject("npm pack did not produce the expected tarball");

    const tarballBytes = readFileSync(tarballPath);
    const actualIntegrity = createHash("sha512").update(tarballBytes).digest("hex");
    if (actualIntegrity !== integrityHex(expectedIntegrity)) {
      reject("packed tarball sha512 does not match registry integrity");
    }

    const extracted = join(tempRoot, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", tarballPath, "-C", extracted], {
      timeout: 30_000
    });
    const packageRoot = join(extracted, "package");
    const installerPath = join(packageRoot, "install.sh");
    const binPath = join(packageRoot, "bin", "infinite-os.mjs");
    const installer = readFileSync(installerPath, "utf8");
    if (!installer.includes(EXPECTED_INSTALLER_URL)) {
      reject("installer download URL changed");
    }
    validateInstallerVersion(installer, version);
    validateInstallerHelp(installerPath);
    validateBinHelp(binPath);
    return installer;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const packument = await fetchJson(`${REGISTRY_ORIGIN}/${PACKAGE_NAME}`);
  const version = validateLatestVersion(packument);
  const metadata = packument.versions?.[version];
  validateRegistryMetadata(metadata, version);
  runNpmSignatureAudit(version);

  const attestations = await fetchJson(metadata.dist.attestations.url);
  const sourceCommit = validateAttestations(attestations, metadata, version);

  const packedInstaller = packAndValidate(version, metadata.dist.integrity);
  const sourceInstaller = await fetchText(
    `${REPOSITORY_URL.replace("https://github.com", "https://raw.githubusercontent.com")}/${sourceCommit}/scripts/install.sh`
  );
  if (packedInstaller !== sourceInstaller) {
    reject("published tarball install.sh differs from attested immutable source");
  }

  process.stdout.write(
    `Validated ${PACKAGE_NAME}@${version} from ${sourceCommit}: trusted publisher, SLSA provenance, five files, installer source, and help smoke\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
