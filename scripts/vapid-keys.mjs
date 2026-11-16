// Print a fresh VAPID key pair in the two forms mousing stores: the public key
// as base64url for the site, the private key as JWK JSON for the cron worker.
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));

console.log(`VAPID_PUBLIC_KEY (wrangler pages secret put VAPID_PUBLIC_KEY):\n${publicKey}\n`);
console.log(`VAPID_PRIVATE_JWK (cd src/cron && wrangler secret put VAPID_PRIVATE_JWK):\n${privateJwk}`);
