// Generate a VAPID keypair for Web Push. Run once:  node scripts/genvapid.js
// Set the output as env vars (never commit the private key):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
import webpush from "web-push";
const keys = webpush.generateVAPIDKeys();
console.log("VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);
console.log("\nAlso set VAPID_SUBJECT to a contact URL, e.g. mailto:you@yourdomain.com");
