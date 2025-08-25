#!/usr/bin/env ts-node

/**
 * Sync GitHub Environment Secrets for staging/prod.
 *
 * Requirements:
 * - GitHub CLI installed: https://cli.github.com/
 * - Logged in: `gh auth login` (or GH_TOKEN env is fine)
 *
 * Usage:
 *   ts-node scripts/sync-secrets.ts --repo your-org/your-repo --env staging --create-env
 *   ts-node scripts/sync-secrets.ts --repo your-org/your-repo --env prod --create-env
 *
 * Reads from: secrets/<env>.env (KEY=VALUE lines)
 * Writes: Environment Secrets named KEY (unprefixed), scoped to the selected environment.
 */

import { execFileSync, spawnSync, execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type EnvName = "staging" | "prod";

const args = process.argv.slice(2);
const repo = getFlag("--repo") || getRepoFromGit();
const envName = (getFlag("--env") as EnvName) || "staging";
const createEnv = hasFlag("--create-env");

if (!repo) die("Missing --repo owner/name");
if (!["staging", "prod"].includes(envName))
  die("--env must be staging or prod");

ensureGhAuth();

const secretsFile = join(process.cwd(), "secrets", `${envName}.env`);
if (!existsSync(secretsFile)) {
  die(`Secrets file not found: ${secretsFile}`);
}

const kv = parseEnvFile(readFileSync(secretsFile, "utf8"));
const envLabel = envName === "prod" ? "production" : "staging"; // GitHub Environment name

// Ensure the GitHub Environment exists
if (createEnv) ensureEnvironment(repo, envLabel);

const keys = Object.keys(kv);
console.log(
  `Syncing ${keys.length} secrets to ${repo} environment=${envLabel} (unprefixed names)`
);

bulkSetSecrets(repo, envLabel, kv);

console.log(`Done. Pushed ${keys.length} secrets to ${repo} (${envLabel})`);

function ensureGhAuth() {
  const res = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
  if (res.status !== 0) die("GitHub CLI not authenticated. Run: gh auth login");
}

function ensureEnvironment(repository: string, env: string) {
  // 1) Check if the environment exists
  const check = spawnSync(
    "gh",
    ["api", `repos/${repository}/environments/${encodeURIComponent(env)}`],
    { stdio: "ignore" }
  );
  if (check.status === 0) return; // already exists

  console.log(`Creating environment '${env}' in ${repository}...`);
  // 2) Create it (no body needed for basic create)
  const res = spawnSync(
    "gh",
    [
      "api",
      "-X",
      "PUT",
      `repos/${repository}/environments/${encodeURIComponent(env)}`,
    ],
    { stdio: "inherit" }
  );
  if (res.status !== 0) die(`Failed to create environment '${env}'.`);
}

function writeTemp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-secret-"));
  const p = join(dir, "body");
  writeFileSync(p, content, { encoding: "utf8" });
  return p;
}

function setGhSecret(
  repository: string,
  name: string,
  value: string,
  env: string
) {
  // use a temp file to support multiline content safely
  const tmpPath = writeTemp(value);
  try {
    const args = [
      "secret",
      "set",
      name,
      "-R",
      repository,
      "--body-file",
      tmpPath,
      "-e",
      env,
    ];
    execFileSync("gh", args, { stdio: "inherit" });
  } catch (e) {
    die(`Failed to set secret ${name} for env ${env}.`);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {}
  }
}

function parseEnvFile(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = val;
  }
  return out;
}

function getFlag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}
function die(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function getRepoFromGit(): string {
  try {
    const url = execSync("git config --get remote.origin.url")
      .toString()
      .trim();
    // handles git@github.com:org/repo.git or https://github.com/org/repo.git
    const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {}
  throw new Error(
    "Unable to determine repo from git config. Pass --repo instead."
  );
}

function bulkSetSecrets(
  repository: string,
  env: string,
  kv: Record<string, string>
) {
  const tmp = join(process.cwd(), `.tmp_${env}_secrets_${Date.now()}.env`);
  const lines = Object.entries(kv).map(
    ([k, v]) => `${k}=${v.replace(/\n/g, "\\n")}`
  );
  writeFileSync(tmp, lines.join("\n"));
  const res = spawnSync(
    "gh",
    ["secret", "set", "-R", repository, "-e", env, "-f", tmp],
    { stdio: "inherit" }
  );
  try {
    unlinkSync(tmp);
  } catch {}
  if (res.status !== 0) die(`Bulk secret set failed for env ${env}`);
}
