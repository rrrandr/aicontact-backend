#!/usr/bin/env bash
# Re-records tests/golden/v1-responses.json by running the ORIGINAL v1
# implementation against an in-memory MongoDB.
#
# The golden file is what makes "non-breaking" a proved claim rather than an
# asserted one: the contract test replays the same request script against the
# current code and requires an identical result, bar the deviations it
# enumerates. You should not normally need to run this - only if the request
# script in tests/contract/scenarios.js gains a case.
#
#   ./scripts/record-v1-golden.sh [baseline-commit]
set -euo pipefail

BASELINE="${1:-0798a0062e7090cfd60e8591ef8499e25069b70e}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/src/controllers" "$WORK/src/models" "$WORK/src/routes" "$WORK/src/middlewears"
for f in src/controllers/userController.js src/models/user.js \
         src/routes/userRoutes.js src/middlewears/errorHandler.js; do
  git -C "$REPO" show "$BASELINE:$f" > "$WORK/$f"
done
cp "$REPO/.babelrc" "$WORK/.babelrc"
ln -s "$REPO/node_modules" "$WORK/node_modules"

cat > "$WORK/generate.js" <<'JS'
import express from "express";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import request from "supertest";
import fs from "fs";
import path from "path";
import { MongoMemoryServer } from "mongodb-memory-server";
import userRouter from "./src/routes/userRoutes";
import ErrorHandler from "./src/middlewears/errorHandler";

const repo = process.env.REPO_ROOT;
const scenarios = require(path.join(repo, "tests/contract/scenarios.js"));
const out = path.join(repo, "tests/golden/v1-responses.json");

const run = async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const app = express();
  app.use(bodyParser.json({ limit: "50mb" }));
  app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));
  app.use("/api/user", userRouter);
  app.use(ErrorHandler);

  const recorded = {};
  for (const s of scenarios) {
    let req = request(app)[s.method](s.path);
    if (s.body) req = req.send(s.body);
    const res = await req;
    recorded[s.name] = { status: res.status, body: res.body };
    console.log(`${s.name.padEnd(24)} -> ${res.status}`);
  }

  fs.writeFileSync(out, JSON.stringify(recorded, null, 2) + "\n");
  console.log(`\nwrote ${out}`);
  await mongoose.disconnect();
  await mongod.stop();
};

run().catch((e) => { console.error(e); process.exit(1); });
JS

echo "Recording v1 golden responses from $BASELINE"
cd "$WORK" && REPO_ROOT="$REPO" "$REPO/node_modules/.bin/babel-node" generate.js
