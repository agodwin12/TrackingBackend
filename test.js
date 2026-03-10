// generate-sig.js
// Run this with: node generate-sig.js
const crypto = require('crypto');

const secret = 'proxym'; // your PAYGATE_WEBHOOK_SECRET

const body = JSON.stringify({
    timestamp:      "2026-03-04 11:00:00",
    status:         "SUCCESS",
    transaction_id: "c576aada-7051-4755-8d6c-cf2451c3a8ed",
    errorCode:      0
});

const sig = crypto.createHmac('sha1', secret).update(body).digest('hex');

console.log('─────────────────────────────────────────');
console.log('📦 Body to paste in Postman:');
console.log(body);
console.log('─────────────────────────────────────────');
console.log('🔐 X-Signature to paste in Postman header:');
console.log(sig);
console.log('─────────────────────────────────────────');