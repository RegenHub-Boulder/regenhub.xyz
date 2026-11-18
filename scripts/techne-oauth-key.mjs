#!/usr/bin/env node
// Makes the private key for regenhub.xyz's Techne OAuth client (TECHNE_OAUTH_PRIVATE_JWK): an ES256 (P-256) JWK
// with a `kid`, printed once to stdout as one line of JSON. Paste it into Coolify's env for the web app; never
// commit it or paste it into chat. The public half is served at /techne/jwks.json. To rotate: make a new one
// (a new kid), set it, redeploy; sessions made with the old key keep working until they next refresh.
// Usage: node scripts/techne-oauth-key.mjs
import { generateKeyPairSync, randomBytes } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const kid = `regenhub-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;
process.stdout.write(JSON.stringify({ ...jwk, kid, alg: "ES256", use: "sig" }) + "\n");
