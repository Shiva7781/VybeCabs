/**
 * Seeds a demo rider and a handful of drivers clustered around a pickup point in
 * central Bengaluru, then puts every driver online + available at a slightly
 * different offset so a ride request has real geo-diverse candidates to find.
 *
 * Usage: npm run seed   (requires the API to be running on http://localhost:3000)
 */
import axios from 'axios';

const BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';

const PICKUP = { lat: 12.9716, lng: 77.5946 }; // MG Road, Bengaluru

const DRIVER_OFFSETS = [
  { name: 'Asha Verma', dLat: 0.003, dLng: 0.002 }, // ~350m away
  { name: 'Ravi Kumar', dLat: -0.004, dLng: 0.001 }, // ~450m away
  { name: 'Priya Singh', dLat: 0.006, dLng: -0.005 }, // ~800m away
  { name: 'Imran Sheikh', dLat: -0.008, dLng: 0.007 }, // ~1.1km away
  { name: 'Divya Nair', dLat: 0.015, dLng: 0.015 }, // ~2.3km away
  { name: 'Karan Mehta', dLat: 0.05, dLng: -0.04 }, // ~7km away (only found on a wider retry round)
];

async function main() {
  const { data: rider } = await axios.post(`${BASE_URL}/riders`, {
    name: 'Demo Rider',
    phone: '+91-9000000000',
  });
  console.log(`Created rider ${rider._id} (${rider.name})`);

  for (const [i, d] of DRIVER_OFFSETS.entries()) {
    const { data: driver } = await axios.post(`${BASE_URL}/drivers`, {
      name: d.name,
      phone: `+91-90000000${10 + i}`,
      licensePlate: `KA01AB${1000 + i}`,
      vehicleType: 'sedan',
    });

    const lat = PICKUP.lat + d.dLat;
    const lng = PICKUP.lng + d.dLng;
    await axios.post(`${BASE_URL}/drivers/${driver._id}/location`, { lat, lng });
    await axios.post(`${BASE_URL}/drivers/${driver._id}/status`, { status: 'AVAILABLE' });

    console.log(`Created driver ${driver._id} (${d.name}) at (${lat.toFixed(4)}, ${lng.toFixed(4)}) - AVAILABLE`);
  }

  console.log('\nSeed complete. Example ride request:');
  console.log(
    `curl -s -X POST ${BASE_URL}/rides -H "Content-Type: application/json" -d '${JSON.stringify({
      riderId: rider._id,
      pickup: PICKUP,
    })}' | jq`,
  );
}

main().catch((err) => {
  console.error('Seed failed:', err.response?.data ?? err.message);
  process.exit(1);
});
