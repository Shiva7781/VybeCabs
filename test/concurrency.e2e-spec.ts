import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Jest/e2e counterpart to scripts/concurrency-test.ts (requirement #6).
 * Requires a real MongoDB + Redis reachable via the same env vars the app
 * itself uses (MONGODB_URI / REDIS_HOST / REDIS_PORT) - start them with
 * `docker compose up -d mongo redis` before running `npm run test:e2e`.
 */
describe('Concurrent ride acceptance (e2e)', () => {
  let app: INestApplication;
  const PICKUP = { lat: 12.9716, lng: 77.5946 };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    // Bind to a real ephemeral TCP port rather than leaving supertest to lazily
    // bind app.getHttpServer() on first use - under genuinely concurrent requests
    // the lazy-bind path was flaky (intermittent ECONNRESET) in this environment.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function createRider() {
    const res = await request(app.getHttpServer())
      .post('/riders')
      .send({ name: 'E2E Rider', phone: '+91-9222222222' })
      .expect(201);
    return res.body._id as string;
  }

  async function createAvailableDriver(name: string, offset: number) {
    const res = await request(app.getHttpServer())
      .post('/drivers')
      .send({ name, phone: `+91-93${Math.floor(Math.random() * 1e8)}`, licensePlate: `KA09XY${Math.floor(Math.random() * 9999)}` })
      .expect(201);
    const driverId = res.body._id as string;

    await request(app.getHttpServer())
      .post(`/drivers/${driverId}/location`)
      .send({ lat: PICKUP.lat + offset * 0.0005, lng: PICKUP.lng + offset * 0.0004 })
      .expect(200);
    await request(app.getHttpServer()).post(`/drivers/${driverId}/status`).send({ status: 'AVAILABLE' }).expect(200);

    return driverId;
  }

  it('assigns exactly one driver when many accept the same ride simultaneously, and stays idempotent on retry', async () => {
    // Must not exceed the server's ALLOCATION_CANDIDATES_PER_ROUND (default 5) or
    // round 1 won't offer every driver created below - see AppModule's ConfigModule,
    // which reads the same env var this test process runs under.
    const DRIVER_COUNT = parseInt(process.env.ALLOCATION_CANDIDATES_PER_ROUND ?? '5', 10);
    const riderId = await createRider();
    const driverIds = await Promise.all(
      Array.from({ length: DRIVER_COUNT }, (_, i) => createAvailableDriver(`E2E Driver ${i}`, i - DRIVER_COUNT / 2)),
    );

    const rideRes = await request(app.getHttpServer())
      .post('/rides')
      .send({ riderId, pickup: PICKUP })
      .expect(201);
    const rideId = rideRes.body._id as string;
    expect(rideRes.body.rounds[0].candidateDriverIds).toHaveLength(DRIVER_COUNT);

    // The actual race: every driver accepts at the exact same instant.
    const results = await Promise.all(
      driverIds.map((driverId) =>
        request(app.getHttpServer())
          .post(`/rides/${rideId}/accept`)
          .send({ driverId })
          .then((res) => ({ driverId, status: res.status, body: res.body })),
      ),
    );

    const winners = results.filter((r) => r.status === 200 && r.body.idempotent === false);
    const conflicts = results.filter((r) => r.status === 409);

    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(DRIVER_COUNT - 1);

    const rideAfter = await request(app.getHttpServer()).get(`/rides/${rideId}`).expect(200);
    expect(rideAfter.body.status).toBe('ASSIGNED');
    expect(rideAfter.body.assignedDriverId).toBe(winners[0].driverId);

    // Idempotency: the winner retrying accept must not change or duplicate the assignment.
    const retry = await request(app.getHttpServer())
      .post(`/rides/${rideId}/accept`)
      .send({ driverId: winners[0].driverId })
      .expect(200);
    expect(retry.body.idempotent).toBe(true);
    expect(retry.body.driverId).toBe(winners[0].driverId);

    // A driver who was never offered this ride must be rejected outright.
    const outsiderId = await createAvailableDriver('E2E Outsider', 999);
    await request(app.getHttpServer()).post(`/rides/${rideId}/accept`).send({ driverId: outsiderId }).expect(403);
  }, 30000);
});
