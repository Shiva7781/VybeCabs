import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { Ride, RideDocument } from './schemas/ride.schema';
import { RideStatus, RoundOutcome } from '../common/enums/ride-status.enum';
import { RedisService } from '../common/redis/redis.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { DriversService } from '../drivers/drivers.service';
import { AppConfig } from '../config/configuration';

export const ALLOCATION_TIMEOUT_QUEUE = 'allocation-timeout';

/**
 * Core allocation engine: runs one or more "rounds" of geo search + notify + wait,
 * expanding the search radius each round, until a driver accepts or rounds run out.
 *
 * Round lifecycle (see RedisService/accept-ride.lua for the atomic accept contract):
 *   1. GEOSEARCH Redis for nearest available drivers within this round's radius,
 *      excluding drivers already offered in earlier rounds of this ride.
 *   2. Open the round in Redis (candidate set + TTL'd "offer open" marker).
 *   3. Persist the round on the Mongo ride document (audit trail / GET /rides/:id).
 *   4. Push a WebSocket `ride:offer` event to every candidate driver.
 *   5. Schedule a delayed BullMQ job that fires exactly when the round's TTL expires.
 *
 * If the delayed job fires and the ride is still SEARCHING on this same round, the
 * round is expired and the next one begins (wider radius), or the ride is marked
 * TIMEOUT if this was the last configured round.
 */
@Injectable()
export class AllocationService {
  private readonly logger = new Logger(AllocationService.name);
  private readonly radiusKmRounds: number[];
  private readonly candidatesPerRound: number;
  private readonly timeoutMs: number;
  private readonly maxRounds: number;

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<RideDocument>,
    @InjectQueue(ALLOCATION_TIMEOUT_QUEUE) private readonly timeoutQueue: Queue,
    private readonly redisService: RedisService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly driversService: DriversService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.radiusKmRounds = config.get('allocation.radiusKmRounds', { infer: true });
    this.candidatesPerRound = config.get('allocation.candidatesPerRound', { infer: true });
    this.timeoutMs = config.get('allocation.timeoutMs', { infer: true });
    this.maxRounds = config.get('allocation.maxRounds', { infer: true });
  }

  async startAllocation(rideId: Types.ObjectId): Promise<void> {
    await this.rideModel.updateOne({ _id: rideId }, { status: RideStatus.SEARCHING });
    await this.runRound(rideId.toString(), 1);
  }

  private jobId(rideId: string, round: number): string {
    return `ride:${rideId}:round:${round}`;
  }

  async runRound(rideId: string, round: number): Promise<void> {
    const ride = await this.rideModel.findById(rideId);
    if (!ride || ride.status !== RideStatus.SEARCHING) {
      // Ride was cancelled / already resolved concurrently - nothing to do.
      return;
    }

    const radiusKm = this.radiusKmRounds[round - 1];
    const alreadyTried = ride.rounds.flatMap((r) => r.candidateDriverIds);

    const candidates = await this.redisService.findNearbyAvailableDrivers(
      ride.pickup.lng,
      ride.pickup.lat,
      radiusKm,
      this.candidatesPerRound,
      alreadyTried,
    );
    const candidateDriverIds = candidates.map((c) => c.driverId);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.timeoutMs);

    ride.currentRound = round;
    ride.rounds.push({
      roundNumber: round,
      radiusKm,
      candidateDriverIds,
      startedAt: now,
      expiresAt,
      outcome: candidateDriverIds.length === 0 ? RoundOutcome.NO_CANDIDATES : RoundOutcome.PENDING,
    });
    await ride.save();

    if (candidateDriverIds.length === 0) {
      this.logger.warn(`Ride ${rideId} round ${round}: no available drivers within ${radiusKm}km`);
      await this.advanceOrTimeout(rideId, round);
      return;
    }

    await this.redisService.openRound(rideId, round, candidateDriverIds, this.timeoutMs);

    for (const driverId of candidateDriverIds) {
      this.realtimeGateway.notifyDriver(driverId, 'ride:offer', {
        rideId,
        round,
        pickup: ride.pickup,
        dropoff: ride.dropoff ?? null,
        expiresAt,
      });
    }

    this.logger.log(
      `Ride ${rideId} round ${round}: offered to [${candidateDriverIds.join(', ')}] within ${radiusKm}km`,
    );

    await this.timeoutQueue.add(
      'round-timeout',
      { rideId, round },
      { delay: this.timeoutMs, jobId: this.jobId(rideId, round) },
    );
  }

  /**
   * Invoked by the BullMQ worker when a round's timeout fires. Re-checks the ride's
   * current state before acting, so a round that was already won (accept beat the
   * timeout) or already advanced is a safe no-op - this is what makes "driver accepts
   * just after timeout fires" and "timeout fires just after driver accepts" both safe.
   */
  async handleRoundTimeout(rideId: string, round: number): Promise<void> {
    const ride = await this.rideModel.findById(rideId);
    if (!ride || ride.status !== RideStatus.SEARCHING || ride.currentRound !== round) {
      return;
    }

    const roundIsStillOpen = await this.redisService.isRoundOpen(rideId, round);
    if (!roundIsStillOpen) {
      // Closed already by a successful accept that hasn't finished persisting yet;
      // let the accept path's own state transition win.
      return;
    }
    await this.redisService.closeRound(rideId, round);

    const roundDoc = ride.rounds.find((r) => r.roundNumber === round);
    if (roundDoc && roundDoc.outcome === RoundOutcome.PENDING) {
      roundDoc.outcome = RoundOutcome.EXPIRED;
      await ride.save();
    }

    await this.advanceOrTimeout(rideId, round);
  }

  private async advanceOrTimeout(rideId: string, round: number): Promise<void> {
    if (round < this.maxRounds) {
      await this.runRound(rideId, round + 1);
      return;
    }

    const ride = await this.rideModel.findById(rideId);
    if (!ride || ride.status !== RideStatus.SEARCHING) return;

    ride.status = RideStatus.TIMEOUT;
    ride.timedOutAt = new Date();
    await ride.save();
    await this.redisService.cleanupRide(rideId, round);

    this.realtimeGateway.notifyRider(ride.riderId.toString(), 'ride:timeout', { rideId });
    this.logger.warn(`Ride ${rideId}: TIMEOUT after ${round} round(s), no driver accepted`);
  }

  /** Cancels any pending timeout job for a round (best-effort; TTL/state checks are the real guarantee). */
  async cancelPendingTimeout(rideId: string, round: number): Promise<void> {
    const job = await this.timeoutQueue.getJob(this.jobId(rideId, round));
    if (job) {
      await job.remove().catch(() => undefined);
    }
  }
}
