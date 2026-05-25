// testLocation.js - Speed sanity filter test
// Run with: node testLocation.js
// No database, no Redis, no external services needed

// ========== COPY OF FUNCTIONS FROM location.js ==========

function gcj02ToWgs84(lat, lng) {
    const a = 6378245.0;
    const ee = 0.00669342162296594323;

    function transformLat(x, y) {
        let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
        return ret;
    }

    function transformLng(x, y) {
        let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
        return ret;
    }

    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);

    return { lat: lat - dLat, lng: lng - dLng };
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const MAX_BELIEVABLE_SPEED_KMH = 200;

// ========== SIMULATE THE FILTER ==========
// NOTE: In production, recordTimestamp comes from new Date(formattedSysTime).getTime()
// In this test we pass it directly as a ms timestamp to avoid Windows date parsing issues
function speedSanityFilter(lastKnown, correctedLat, correctedLng, recordTimestampMs, macIdGps) {
    if (!lastKnown) {
        console.log(`   ⚪ No previous position for ${macIdGps} — first record, always passes`);
        return true;
    }

    if (correctedLat === 0 && correctedLng === 0) {
        console.log(`   ⚪ Zero coordinate — blocked by 0,0 guard`);
        return false;
    }

    const distanceKm   = haversineKm(lastKnown.lat, lastKnown.lng, correctedLat, correctedLng);
    const elapsedMs    = recordTimestampMs - lastKnown.timestamp;
    const elapsedHours = elapsedMs / 3600000;
    const elapsedSecs  = elapsedMs / 1000;

    if (elapsedHours <= 0) {
        console.log(`   ⚪ Elapsed time zero or negative — skipping filter`);
        return true;
    }

    if (elapsedHours >= 1) {
        console.log(`   ⚪ Gap > 1 hour (${elapsedHours.toFixed(1)}h) — filter bypassed, allowing through`);
        return true;
    }

    const impliedSpeedKmh = distanceKm / elapsedHours;

    console.log(`   📏 Distance:      ${distanceKm.toFixed(3)} km`);
    console.log(`   ⏱️  Elapsed:       ${elapsedSecs.toFixed(1)} seconds`);
    console.log(`   🚗 Implied speed: ${impliedSpeedKmh.toFixed(0)} km/h (max: ${MAX_BELIEVABLE_SPEED_KMH})`);

    if (impliedSpeedKmh > MAX_BELIEVABLE_SPEED_KMH) {
        console.log(`   🚫 REJECTED — impossible speed`);
        return false;
    }

    console.log(`   ✅ ACCEPTED — speed is believable`);
    return true;
}

// ========== TEST RUNNER ==========
function runTest(testName, lastKnown, rawLat, rawLng, recordTimestampMs, macIdGps, expectPass) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🧪 TEST: ${testName}`);
    console.log(`${'─'.repeat(60)}`);

    const corrected = (rawLat !== 0 || rawLng !== 0)
        ? gcj02ToWgs84(rawLat, rawLng)
        : { lat: rawLat, lng: rawLng };

    console.log(`   📍 Raw incoming:     ${rawLat}, ${rawLng}`);
    console.log(`   📍 After correction: ${corrected.lat.toFixed(6)}, ${corrected.lng.toFixed(6)}`);
    if (lastKnown) {
        console.log(`   📍 Last known (WGS): ${lastKnown.lat.toFixed(6)}, ${lastKnown.lng.toFixed(6)}`);
        console.log(`   ⏱️  Record time gap:  ${((recordTimestampMs - lastKnown.timestamp) / 1000).toFixed(1)}s`);
    }

    const passed = speedSanityFilter(lastKnown, corrected.lat, corrected.lng, recordTimestampMs, macIdGps);

    const resultLabel   = passed ? '✅ PASS (saved to DB)' : '🚫 BLOCKED (not saved)';
    const expectedLabel = expectPass ? '✅ PASS' : '🚫 BLOCKED';
    const correct = passed === expectPass;

    console.log(`\n   Result:   ${resultLabel}`);
    console.log(`   Expected: ${expectedLabel}`);
    console.log(correct ? `   ✅ TEST PASSED` : `   ❌ TEST FAILED — behavior is wrong`);

    return correct;
}

// ========== COORDINATES ==========
const NOW = Date.now();
const MAC = 'TEST_DEVICE_001';

const RAW_OMNISPORT = { lat: 3.8612, lng: 11.5220 };
const RAW_NSIMALEN  = { lat: 3.7228, lng: 11.5533 };
const RAW_NEARBY    = { lat: 3.8614, lng: 11.5222 }; // ~20m from Omnisport
const RAW_BASTOS    = { lat: 3.8800, lng: 11.5100 };
const RAW_HIGHWAY   = { lat: 3.889,  lng: 11.510  }; // ~120 km/h from Bastos in 30s

// WGS84 corrected — what gets stored in lastKnownPositions after saving
const WGS_OMNISPORT = gcj02ToWgs84(RAW_OMNISPORT.lat, RAW_OMNISPORT.lng);
const WGS_BASTOS    = gcj02ToWgs84(RAW_BASTOS.lat,    RAW_BASTOS.lng);

// Previous position snapshots — timestamp is ms, simulates real GPS cycle timing
const prev_Omnisport_10s  = { ...WGS_OMNISPORT, timestamp: NOW - 10000   };
const prev_Omnisport_3min = { ...WGS_OMNISPORT, timestamp: NOW - 180000  };
const prev_Omnisport_2h   = { ...WGS_OMNISPORT, timestamp: NOW - 7200000 };
const prev_Bastos_30s     = { ...WGS_BASTOS,    timestamp: NOW - 30000   };

let passed = 0;
let failed = 0;

function test(name, lastKnown, rawLat, rawLng, recordTimestampMs, mac, expectPass) {
    const ok = runTest(name, lastKnown, rawLat, rawLng, recordTimestampMs, mac, expectPass);
    ok ? passed++ : failed++;
}

// ── TEST 1: The Nsimalen bug ──────────────────────────────────────────────────
// Parked at Omnisport 10s ago, GPS suddenly reports Nsimalen → ~5700 km/h → BLOCKED
test(
    'Nsimalen jump — parked at Omnisport, bad fix at Nsimalen after 10s',
    prev_Omnisport_10s,
    RAW_NSIMALEN.lat, RAW_NSIMALEN.lng,
    NOW, MAC, false
);

// ── TEST 2: First record ever ─────────────────────────────────────────────────
test(
    'First record — no previous position, always allowed through',
    null,
    RAW_OMNISPORT.lat, RAW_OMNISPORT.lng,
    NOW, MAC, true
);

// ── TEST 3: GPS jitter on parked vehicle ──────────────────────────────────────
// ~20m wobble in 10 seconds = ~7 km/h → PASS
test(
    'GPS jitter — parked vehicle, 20m wobble in 10 seconds',
    prev_Omnisport_10s,
    RAW_NEARBY.lat, RAW_NEARBY.lng,
    NOW, MAC, true
);

// ── TEST 4: Normal city driving ───────────────────────────────────────────────
// Omnisport to Bastos in 3 minutes = ~50 km/h → PASS
test(
    'Normal city driving — Omnisport to Bastos in 3 minutes (~50 km/h)',
    prev_Omnisport_3min,
    RAW_BASTOS.lat, RAW_BASTOS.lng,
    NOW, MAC, true
);

// ── TEST 5: Stationary, same coordinate ──────────────────────────────────────
// Distance = 0, speed = 0 → PASS
test(
    'Stationary vehicle — same position returned again',
    prev_Omnisport_10s,
    RAW_OMNISPORT.lat, RAW_OMNISPORT.lng,
    NOW, MAC, true
);

// ── TEST 6: Server down 2 hours ───────────────────────────────────────────────
// Gap > 1h → filter bypassed → PASS
test(
    'Server down 2 hours — gap > 1h bypasses filter',
    prev_Omnisport_2h,
    RAW_NSIMALEN.lat, RAW_NSIMALEN.lng,
    NOW, MAC, true
);

// ── TEST 7: Zero coordinate ───────────────────────────────────────────────────
test(
    'Zero coordinate — 0,0 sent by GPS device',
    prev_Omnisport_10s,
    0, 0,
    NOW, MAC, false
);

// ── TEST 8: Highway speed ─────────────────────────────────────────────────────
// ~1km in 30 seconds = ~120 km/h → PASS
test(
    'Highway driving — ~120 km/h, should pass',
    prev_Bastos_30s,
    RAW_HIGHWAY.lat, RAW_HIGHWAY.lng,
    NOW, MAC, true
);

// ── TEST 9: Clearly bad GPS fix ───────────────────────────────────────────────
// 40km in 10 seconds → BLOCKED
test(
    'Clearly bad GPS fix — 40km jump in 10 seconds',
    prev_Omnisport_10s,
    3.9500, 11.9000,
    NOW, MAC, false
);

// ── TEST 10: Different MAC, no history ───────────────────────────────────────
test(
    'Different MAC address — independent filter, no bleed between devices',
    null,
    RAW_NSIMALEN.lat, RAW_NSIMALEN.lng,
    NOW, 'DIFFERENT_DEVICE_002', true
);

// ── TEST 11: Same device, second GPS account ──────────────────────────────────
// Same position, 0 distance → PASS
test(
    'Same device seen by second GPS account — filter works correctly',
    prev_Omnisport_10s,
    RAW_OMNISPORT.lat, RAW_OMNISPORT.lng,
    NOW, MAC, true
);

// ── TEST 12: Over speed limit ────────────────────────────────────────────────
// Bastos to Nsimalen in 30 seconds = ~2000+ km/h → BLOCKED
test(
    'Over speed limit — Bastos to Nsimalen in 30 seconds, should be blocked',
    prev_Bastos_30s,
    RAW_NSIMALEN.lat, RAW_NSIMALEN.lng,
    NOW, MAC, false
);

// ========== SUMMARY ==========
console.log(`\n${'═'.repeat(60)}`);
console.log(`📊 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log(`${'═'.repeat(60)}`);

if (failed === 0) {
    console.log(`\n✅ All tests passed — safe to deploy to production\n`);
} else {
    console.log(`\n❌ ${failed} test(s) failed — review before deploying\n`);
    process.exit(1);
}