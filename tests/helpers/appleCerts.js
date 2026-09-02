const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Builds a throwaway ECDSA certificate chain so JWS verification can be
 * exercised for real - chain construction, root pinning, signature checking -
 * rather than mocked out.
 *
 * Keys are generated per run into a temporary directory and never committed.
 */
const run = (args, cwd) =>
  execFileSync("openssl", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

const der = (dir, name) =>
  run(["x509", "-in", name, "-outform", "DER"], dir).toString("base64");

const makeCa = (dir, name, cn, days = 3650) => {
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`], dir);
  run(["req", "-x509", "-new", "-key", `${name}.key`, "-sha256", "-days", String(days),
       "-subj", `/CN=${cn}`, "-out", `${name}.crt`], dir);
};

const signCert = (dir, name, cn, issuer, isCa, days = 825) => {
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`], dir);
  run(["req", "-new", "-key", `${name}.key`, "-subj", `/CN=${cn}`, "-out", `${name}.csr`], dir);
  fs.writeFileSync(
    path.join(dir, `${name}.ext`),
    isCa
      ? "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n"
      : "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n"
  );
  run(["x509", "-req", "-in", `${name}.csr`, "-CA", `${issuer}.crt`, "-CAkey", `${issuer}.key`,
       "-CAcreateserial", "-days", String(days), "-sha256", "-extfile", `${name}.ext`,
       "-out", `${name}.crt`], dir);
};

const buildChain = (dir, prefix) => {
  makeCa(dir, `${prefix}root`, `Test Root ${prefix}`);
  signCert(dir, `${prefix}int`, `Test Intermediate ${prefix}`, `${prefix}root`, true, 1825);
  signCert(dir, `${prefix}leaf`, `Test Leaf ${prefix}`, `${prefix}int`, false);

  return {
    rootDer: der(dir, `${prefix}root.crt`),
    x5c: [der(dir, `${prefix}leaf.crt`), der(dir, `${prefix}int.crt`), der(dir, `${prefix}root.crt`)],
    leafKey: fs.readFileSync(path.join(dir, `${prefix}leaf.key`), "utf8"),
  };
};

let cached;

const appleCerts = () => {
  if (cached) return cached;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aicontact-certs-"));

  cached = {
    // The chain the server is configured to trust.
    trusted: buildChain(dir, "t"),
    // A structurally valid chain rooted somewhere else entirely.
    untrusted: buildChain(dir, "u"),
    dir,
  };

  return cached;
};

const opensslAvailable = () => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

module.exports = { appleCerts, opensslAvailable };
