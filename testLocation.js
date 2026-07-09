#!/usr/bin/env node
// gps_datum_test.js — figure out which coordinate system 18gps actually returns
// for your Cameroon devices, by laying every candidate on Google Maps.
//
// For each MAC it prints 3 candidate positions:
//   A) RAW            — coordinate exactly as the API returns it (assume WGS84)
//   B) GCJ-02→WGS84   — what your old code did (China-offset removed)
//   C) BD-09→WGS84    — in case the platform is handing back Baidu coords
//
// Open each link. Whichever pin sits EXACTLY on the spot the moto is really
// parked is the correct transform. Tell me the letter and I'll lock it in.
//
// Run: node gps_datum_test.js   (Node 18+, no npm install)

const API        = process.env.GPS_API_URL        || 'http://apitest.18gps.net/GetDateServices.asmx';
const LOGIN_URL  = process.env.GPS_LOGIN_URL       || 'http://appzzl.18gps.net/';
const LOGIN_NAME = process.env.GPS_LOGIN_NAME_1    || 'Proxym_tracking';
const LOGIN_PASS = process.env.GPS_LOGIN_PASSWORD_1 || 'proxym123';

const TARGET_MACS = ['863957076555819', '863957076712089'];

const PI = Math.PI;
const A  = 6378245.0;
const EE = 0.00669342162296594323;

function transformLat(x, y) {
    let r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
    r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI)) * 2/3;
    r += (20*Math.sin(y*PI) + 40*Math.sin(y/3*PI)) * 2/3;
    r += (160*Math.sin(y/12*PI) + 320*Math.sin(y*PI/30)) * 2/3;
    return r;
}
function transformLng(x, y) {
    let r = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
    r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI)) * 2/3;
    r += (20*Math.sin(x*PI) + 40*Math.sin(x/3*PI)) * 2/3;
    r += (150*Math.sin(x/12*PI) + 300*Math.sin(x/30*PI)) * 2/3;
    return r;
}

// GCJ-02 -> WGS84  (removes China offset; identity-ish outside China)
function gcj02ToWgs84(lat, lng) {
    let dLat = transformLat(lng-105, lat-35), dLng = transformLng(lng-105, lat-35);
    const radLat = lat/180*PI;
    let magic = Math.sin(radLat); magic = 1 - EE*magic*magic;
    const sm = Math.sqrt(magic);
    dLat = (dLat*180) / ((A*(1-EE)) / (magic*sm) * PI);
    dLng = (dLng*180) / (A/sm * Math.cos(radLat) * PI);
    return { lat: lat-dLat, lng: lng-dLng };
}

// BD-09 -> GCJ-02  (Baidu offset)
function bd09ToGcj02(lat, lng) {
    const xPi = PI * 3000 / 180;
    const x = lng - 0.0065, y = lat - 0.006;
    const z = Math.sqrt(x*x + y*y) - 0.00002 * Math.sin(y * xPi);
    const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * xPi);
    return { lat: z*Math.sin(theta), lng: z*Math.cos(theta) };
}
function bd09ToWgs84(lat, lng) {
    const g = bd09ToGcj02(lat, lng);
    return gcj02ToWgs84(g.lat, g.lng);
}

function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2-lat1)*PI/180, dLng = (lng2-lng1)*PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*PI/180)*Math.cos(lat2*PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
const fmt   = (p) => `${p.lat.toFixed(7)}, ${p.lng.toFixed(7)}`;
const gmaps = (p) => `https://maps.google.com/?q=${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;
const toDate = (ms) => { const n = parseInt(ms); return n ? new Date(n).toISOString().slice(0,19).replace('T',' ') : 'n/a'; };

(async () => {
    const loginParams = new URLSearchParams({
        LoginName: LOGIN_NAME, LoginPassword: LOGIN_PASS,
        LoginType: 'ENTERPRISE', language: 'en', timeZone: '8',
        apply: 'APP', ISMD5: '0', loginUrl: LOGIN_URL,
    });
    const login = await (await fetch(`${API}/loginSystem?${loginParams}`)).json();
    if (login.success !== 'true') { console.error('❌ Login failed:', login.msg || login); process.exit(1); }
    console.log(`✅ Logged in — UserID=${login.id}\n`);

    const params = new URLSearchParams({ method: 'getDeviceListByCustomId', id: login.id, mds: login.mds, mapType: 'WGS84' });
    const data = await (await fetch(`${API}/GetDate?${params}`)).json();
    if (data.success !== 'true') { console.error('❌ Fetch failed:', data.errorDescribe || data); process.exit(1); }

    const found = new Set();
    for (const dev of (data.data || [])) {
        for (const r of (dev.records || [])) {
            const mac = String(r[11]);
            if (!TARGET_MACS.includes(mac)) continue;
            found.add(mac);

            const rawLat = parseFloat(r[3]), rawLng = parseFloat(r[2]);
            const raw  = { lat: rawLat, lng: rawLng };
            const gcj  = gcj02ToWgs84(rawLat, rawLng);
            const bd   = bd09ToWgs84(rawLat, rawLng);

            console.log('═'.repeat(72));
            console.log(`📍 MAC ${mac}   (speed ${r[8]} km/h, fix ${toDate(r[6])})`);
            console.log('─'.repeat(72));
            console.log(`  A) RAW (as-is, assume WGS84)`);
            console.log(`     ${fmt(raw)}`);
            console.log(`     ${gmaps(raw)}`);
            console.log('');
            console.log(`  B) GCJ-02 → WGS84  (your old code)   [${haversineM(raw.lat,raw.lng,gcj.lat,gcj.lng).toFixed(0)} m from A]`);
            console.log(`     ${fmt(gcj)}`);
            console.log(`     ${gmaps(gcj)}`);
            console.log('');
            console.log(`  C) BD-09 → WGS84   (only if A & B both miss) [${haversineM(raw.lat,raw.lng,bd.lat,bd.lng).toFixed(0)} m from A]`);
            console.log(`     ${fmt(bd)}`);
            console.log(`     ${gmaps(bd)}`);
            console.log('');
        }
    }
    console.log('═'.repeat(72));
    for (const mac of TARGET_MACS) if (!found.has(mac)) console.log(`⚠️  ${mac} not found in account device list`);
    console.log('\n👉 Open A, B, C for one moto you can physically locate. Whichever pin');
    console.log('   sits exactly on the real spot is the correct transform — tell me the letter.');
})().catch(e => { console.error('🔥', e.message); process.exit(1); });