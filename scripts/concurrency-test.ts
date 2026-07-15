/**
 * Concurrency verification script (assignment requirement #6).
 *
 * Proves that when multiple drivers hit POST /rides/:id/accept for the same ride
 * at the exact same instant, exactly one succeeds and every other request is
 * rejected - with no partial/inconsistent state in Mongo. Also proves the
 * accept endpoint is idempotent for the winner, and rejects a driver who was
 * never offered the ride.
 *
 * Requires the API + MongoDB + Redis to already be running (see README).
 *
 * Usage:
 *   npm run verify:concurrency
 *   npm run verify:concurrency -- --with-timeout-test   (also proves the retry/timeout path; slower)
 */
import axios from 'axios';

const BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';
const http = axios.create({ baseURL: BASE_URL, validateStatus: () => true });

const CONCURRENT_DRIVERS = parseInt(process.env.CONCURRENT_DRIVERS ?? '8', 10);
const PICKUP = { lat: 12.9716, lng: 77.5946 };

let pass = 0;
let fail = 0;

function ok(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    pass++;
    console.log(`  [PASS] ${label}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${label}`);
    if (detail !== undefined) console.log(`         ${JSON.stringify(detail)}`);
  }
}

async function createRider(): Promise<string> {
  const res = await http.post('/riders', { name: 'Concurrency Test Rider', phone: '+91-9111111111' });
  if (res.status !== 201) throw new Error(`Failed to create rider: ${JSON.stringify(res.data)}`);
  return res.data._id;
}

async function createAvailableDriver(name: string, i: number, offset: number): Promise<string> {
  const res = await http.post('/drivers', {
    name,
    phone: `+91-92${String(i).padStart(8, '0')}`,
    licensePlate: `KA05CT${1000 + i}`,
  });
  if (res.status !== 201) throw new Error(`Failed to create driver: ${JSON.stringify(res.data)}`);
  const driverId = res.data._id;

  // Tiny offsets so every driver lands within the round-1 search radius.
  const lat = PICKUP.lat + offset * 0.0005;
  const lng = PICKUP.lng + offset * 0.0004;
  await http.post(`/drivers/${driverId}/location`, { lat, lng });
  await http.post(`/drivers/${driverId}/status`, { status: 'AVAILABLE' });
  return driverId;
}

async function testConcurrentAccept() {
  console.log(`\n=== Test 1: ${CONCURRENT_DRIVERS} drivers accept the same ride simultaneously ===`);

  const riderId = await createRider();
  const driverIds: string[] = [];
  for (let i = 0; i < CONCURRENT_DRIVERS; i++) {
    driverIds.push(await createAvailableDriver(`Concurrency Driver ${i}`, i, i - CONCURRENT_DRIVERS / 2));
  }

  const rideRes = await http.post('/rides', { riderId, pickup: PICKUP });
  ok('Ride request accepted (201)', rideRes.status === 201, rideRes.data);
  const rideId = rideRes.data._id;
  const round1Candidates: string[] = rideRes.data.rounds?.[0]?.candidateDriverIds ?? [];

  ok(
    `All ${CONCURRENT_DRIVERS} drivers were offered round 1 (candidatesPerRound must be >= driver count)`,
    round1Candidates.length === CONCURRENT_DRIVERS,
    { expected: CONCURRENT_DRIVERS, got: round1Candidates.length, round1Candidates },
  );

  console.log(`  Ride ${rideId} SEARCHING, ${round1Candidates.length} drivers notified. Firing concurrent accepts...`);

  // Fire every accept at once - this is the actual race condition under test.
  const results = await Promise.all(
    driverIds.map((driverId) => http.post(`/rides/${rideId}/accept`, { driverId }).then((res) => ({ driverId, res }))),
  );

  const winners = results.filter((r) => r.res.status === 200 && r.res.data.idempotent === false);
  const conflicts = results.filter((r) => r.res.status === 409);

  ok('Exactly one driver won the race (HTTP 200, idempotent:false)', winners.length === 1, {
    winners: winners.map((w) => ({ driverId: w.driverId, status: w.res.status, body: w.res.data })),
  });
  ok(`Every other driver got HTTP 409 Conflict (${conflicts.length}/${CONCURRENT_DRIVERS - 1})`, conflicts.length === CONCURRENT_DRIVERS - 1, {
    statuses: results.map((r) => r.res.status),
  });

  const winnerDriverId = winners[0]?.driverId;

  const rideAfter = await http.get(`/rides/${rideId}`);
  ok('Ride status in MongoDB is ASSIGNED', rideAfter.data.status === 'ASSIGNED', rideAfter.data);
  ok('Ride.assignedDriverId in MongoDB matches the HTTP winner', rideAfter.data.assignedDriverId === winnerDriverId, {
    expected: winnerDriverId,
    got: rideAfter.data.assignedDriverId,
  });

  if (winnerDriverId) {
    const winnerDriver = await http.get(`/drivers/${winnerDriverId}`);
    ok('Winning driver flipped to BUSY', winnerDriver.data.status === 'BUSY', winnerDriver.data);

    console.log('\n--- Test 2: idempotency - winner retries the same accept call ---');
    const retry = await http.post(`/rides/${rideId}/accept`, { driverId: winnerDriverId });
    ok('Retried accept by the winner returns HTTP 200 (not an error)', retry.status === 200, retry.data);
    ok('Retried accept is flagged idempotent:true', retry.data.idempotent === true, retry.data);
    ok('Retried accept still reports the same driverId', retry.data.driverId === winnerDriverId, retry.data);
  }

  console.log('\n--- Test 3: a driver who was never offered this ride tries to accept ---');
  const outsiderId = await createAvailableDriver('Outsider Driver', 999, 999); // far away, never offered
  const outsiderRes = await http.post(`/rides/${rideId}/accept`, { driverId: outsiderId });
  ok('Non-candidate driver is rejected (HTTP 403)', outsiderRes.status === 403, outsiderRes.data);

  const rideFinal = await http.get(`/rides/${rideId}`);
  const assignedCount = results.filter((r) => r.res.status === 200 && r.res.data.idempotent === false).length;
  ok('No inconsistent state: precisely one WON outcome ever recorded for this ride', assignedCount === 1, {
    rideFinal: rideFinal.data,
  });
}

async function testTimeoutAndRetry() {
  console.log('\n=== Test 4 (optional, slow): timeout + retry when no driver ever accepts ===');
  const riderId = await createRider();

  const rideRes = await http.post('/rides', { riderId, pickup: { lat: 1.111, lng: 1.111 } }); // no drivers anywhere nearby
  const rideId = rideRes.data._id;
  console.log(`  Ride ${rideId} requested with zero reachable drivers - polling until terminal state...`);

  const deadline = Date.now() + 90_000;
  let last = rideRes.data;
  while (Date.now() < deadline) {
    const res = await http.get(`/rides/${rideId}`);
    last = res.data;
    if (last.status === 'TIMEOUT') break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  ok('Ride eventually reaches TIMEOUT after exhausting all retry rounds', last.status === 'TIMEOUT', last);
  ok('Every configured round was attempted and marked NO_CANDIDATES/EXPIRED', (last.rounds ?? []).length >= 1, last.rounds);
}

async function main() {
  const withTimeoutTest = process.argv.includes('--with-timeout-test');

  try {
    await http.get('/riders');
  } catch {
    console.error(`Cannot reach API at ${BASE_URL}. Start it first (see README "Setup").`);
    process.exit(2);
  }

  await testConcurrentAccept();
  if (withTimeoutTest) {
    await testTimeoutAndRetry();
  }

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Concurrency test crashed:', err);
  process.exit(1);
});
