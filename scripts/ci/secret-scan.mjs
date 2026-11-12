import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = process.cwd();
const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: rootDir, encoding: "utf8" });
const files = out
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const SECRET_RULES = [
  {
    name: "PEM Private Key Block",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    name: "AWS Access Key ID",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    name: "GitHub Token",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/,
  },
  {
    name: "GitLab Personal Access Token",
    regex: /\bglpat-[A-Za-z0-9\-_]{20,}\b/,
  },
  {
    name: "Anthropic API Key",
    regex: /\bsk-ant-(?:api\d+-)?[A-Za-z0-9\-_]{24,}\b/,
  },
  {
    name: "Stripe / OpenAI Live Key",
    regex: /\bsk-(?:live|proj)-[A-Za-z0-9\-_]{24,}\b/,
  },
  {
    name: "Slack Token",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/,
  },
  {
    name: "Google API Key",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/,
  },
  {
    name: "Non-Local Database URL With Credentials",
    regex: /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s/]+@(?!localhost\b|127\.0\.0\.1\b)[^\s/]+/i,
  },
];

const findings = [];
let scannedCount = 0;

for (const relPath of files) {
  if (relPath === "scripts/ci/secret-scan.mjs") {
    continue;
  }
  const absPath = resolve(rootDir, relPath);
  if (!existsSync(absPath)) {
    continue;
  }
  scannedCount += 1;
  const content = readFileSync(absPath, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of SECRET_RULES) {
      if (rule.regex.test(line)) {
        findings.push(`${relPath}:${i + 1}: [${rule.name}]`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error("Secret scanning FAILED:\n" + findings.join("\n"));
  process.exit(1);
}

console.log(`Secret scanning PASSED (${scannedCount} source files scanned, 0 leaks found).`);
