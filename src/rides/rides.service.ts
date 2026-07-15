import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Ride, RideDocument } from './schemas/ride.schema';
import { RequestRideDto } from './dto/request-ride.dto';
import { RideStatus, RoundOutcome } from '../common/enums/ride-status.enum';
import { AllocationService } from './allocation.service';
import { AcceptResult, RedisService } from '../common/redis/redis.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { DriversService } from '../drivers/drivers.service';
import { RidersService } from '../riders/riders.service';

@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<RideDocument>,
    private readonly allocationService: AllocationService,
    private readonly redisService: RedisService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly driversService: DriversService,
    private readonly ridersService: RidersService,
  ) {}

  async requestRide(dto: RequestRideDto): Promise<RideDocument> {
    await this.ridersService.findByIdOrThrow(dto.riderId);

    const ride = await this.rideModel.create({
      riderId: new Types.ObjectId(dto.riderId),
      pickup: dto.pickup,
      dropoff: dto.dropoff,
      status: RideStatus.REQUESTED,
      requestedAt: new Date(),
    });

    await this.allocationService.startAllocation(ride._id);
    return this.findByIdOrThrow(ride._id.toString());
  }

  async findByIdOrThrow(id: string): Promise<RideDocument> {
    const ride = await this.rideModel.findById(id);
    if (!ride) {
      throw new NotFoundException(`Ride ${id} not found`);
    }
    return ride;
  }

  /**
   * Handles a driver's acceptance of a ride offer. All race-condition handling
   * happens inside RedisService.acceptRide (atomic Lua script) - this method only
   * interprets the result and persists it. See accept-ride.lua for the full
   * atomicity contract and README "Concurrency" section for the write-up.
   */
  async acceptRide(rideId: string, driverId: string) {
    const ride = await this.findByIdOrThrow(rideId);
    await this.driversService.findByIdOrThrow(driverId);

    if (ride.status === RideStatus.TIMEOUT || ride.status === RideStatus.CANCELLED) {
      throw new ConflictException(`Ride ${rideId} is ${ride.status} and no longer accepting offers`);
    }

    const round = ride.currentRound || 1;
    const result = await this.redisService.acceptRide(rideId, round, driverId);

    switch (result) {
      case AcceptResult.WON:
        return this.finalizeWin(rideId, round, driverId);
      case AcceptResult.ALREADY_YOURS:
        return { rideId, status: RideStatus.ASSIGNED, driverId, idempotent: true, message: 'Already assigned to you' };
      case AcceptResult.NOT_A_CANDIDATE:
        throw new ForbiddenException('You were not offered this ride, or the offer has already expired');
      case AcceptResult.REJECTED:
      default:
        throw new ConflictException('This ride offer is no longer available (already assigned or expired)');
    }
  }

  private async finalizeWin(rideId: string, round: number, driverId: string) {
    const updated = await this.rideModel.findOneAndUpdate(
      { _id: rideId, status: RideStatus.SEARCHING },
      {
        status: RideStatus.ASSIGNED,
        assignedDriverId: new Types.ObjectId(driverId),
        assignedAt: new Date(),
      },
      { new: true },
    );

    if (!updated) {
      this.logger.error(`Ride ${rideId} won by driver ${driverId} but Mongo status was not SEARCHING`);
    } else {
      const roundDoc = updated.rounds.find((r) => r.roundNumber === round);
      if (roundDoc) {
        roundDoc.outcome = RoundOutcome.WON;
        await updated.save();
      }
    }

    await this.driversService.markBusy(driverId);
    await this.allocationService.cancelPendingTimeout(rideId, round);

    const riderId = updated?.riderId ?? (await this.findByIdOrThrow(rideId)).riderId;
    this.realtimeGateway.notifyRider(riderId.toString(), 'ride:assigned', { rideId, driverId });

    const losingCandidates = (updated?.rounds.find((r) => r.roundNumber === round)?.candidateDriverIds ?? []).filter(
      (id) => id !== driverId,
    );
    for (const otherDriverId of losingCandidates) {
      this.realtimeGateway.notifyDriver(otherDriverId, 'ride:offer:closed', { rideId, reason: 'ASSIGNED' });
    }

    this.logger.log(`Ride ${rideId} ASSIGNED to driver ${driverId} (round ${round})`);
    return { rideId, status: RideStatus.ASSIGNED, driverId, idempotent: false, message: 'Ride assigned' };
  }

  async cancelRide(rideId: string): Promise<RideDocument> {
    const ride = await this.findByIdOrThrow(rideId);
    if (ride.status !== RideStatus.REQUESTED && ride.status !== RideStatus.SEARCHING) {
      throw new ConflictException(`Ride ${rideId} cannot be cancelled from status ${ride.status}`);
    }

    const round = ride.currentRound || 0;
    if (round > 0) {
      // Close the Redis round gate first so no in-flight accept can race past this point.
      await this.redisService.closeRound(rideId, round);
      await this.allocationService.cancelPendingTimeout(rideId, round);
      const candidates = ride.rounds.find((r) => r.roundNumber === round)?.candidateDriverIds ?? [];
      for (const driverId of candidates) {
        this.realtimeGateway.notifyDriver(driverId, 'ride:offer:closed', { rideId, reason: 'CANCELLED' });
      }
    }

    ride.status = RideStatus.CANCELLED;
    ride.cancelledAt = new Date();
    await ride.save();
    await this.redisService.cleanupRide(rideId, Math.max(round, 1));

    return ride;
  }
}
