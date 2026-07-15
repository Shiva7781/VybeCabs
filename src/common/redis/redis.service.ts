import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

export interface GeoCandidate {
  driverId: string;
  distanceKm: number;
  lng: number;
  lat: number;
}

export const AVAILABLE_DRIVERS_GEO_KEY = 'geo:drivers:available';

/**
 * Result codes returned by the acceptRide Lua script - see accept-ride.lua for the
 * full atomicity contract (this is the single source of truth for race handling).
 */
export enum AcceptResult {
  WON = 1,
  ALREADY_YOURS = 2,
  REJECTED = 0,
  NOT_A_CANDIDATE = -1,
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy() {
    // Without this the raw ioredis client keeps its socket open forever, which
    // prevents graceful shutdown (and made Jest e2e runs hang after tests passed).
    await this.redis.quit();
  }

  onModuleInit() {
    const luaPath = join(__dirname, 'lua', 'accept-ride.lua');
    const script = readFileSync(luaPath, 'utf-8');
    this.redis.defineCommand('acceptRide', {
      numberOfKeys: 3,
      lua: script,
    });
  }

  get client(): Redis {
    return this.redis;
  }

  // ---- Geo: driver location tracking ----

  async setDriverAvailable(driverId: string, lng: number, lat: number): Promise<void> {
    await this.redis.geoadd(AVAILABLE_DRIVERS_GEO_KEY, lng, lat, driverId);
  }

  async removeDriverAvailability(driverId: string): Promise<void> {
    await this.redis.zrem(AVAILABLE_DRIVERS_GEO_KEY, driverId);
  }

  async isDriverAvailable(driverId: string): Promise<boolean> {
    const pos = await this.redis.geopos(AVAILABLE_DRIVERS_GEO_KEY, driverId);
    return !!pos?.[0];
  }

  /**
   * Nearest available drivers within radiusKm, closest first, excluding any driverId in `exclude`.
   */
  async findNearbyAvailableDrivers(
    lng: number,
    lat: number,
    radiusKm: number,
    limit: number,
    exclude: string[] = [],
  ): Promise<GeoCandidate[]> {
    const excludeSet = new Set(exclude);
    // Over-fetch a bit so that excluding already-tried drivers still leaves us `limit` results.
    const fetchCount = limit + exclude.length;

    const raw = (await this.redis.geosearch(
      AVAILABLE_DRIVERS_GEO_KEY,
      'FROMLONLAT',
      lng,
      lat,
      'BYRADIUS',
      radiusKm,
      'km',
      'ASC',
      'COUNT',
      fetchCount,
      'WITHCOORD',
      'WITHDIST',
    )) as unknown as [string, string, [string, string]][];

    const candidates: GeoCandidate[] = raw
      .map(([driverId, distance, coord]) => ({
        driverId,
        distanceKm: parseFloat(distance),
        lng: parseFloat(coord[0]),
        lat: parseFloat(coord[1]),
      }))
      .filter((c) => !excludeSet.has(c.driverId));

    return candidates.slice(0, limit);
  }

  // ---- Allocation round bookkeeping ----

  private assignedKey(rideId: string): string {
    return `ride:${rideId}:assigned`;
  }

  private offerKey(rideId: string, round: number): string {
    return `ride:${rideId}:round:${round}:offer`;
  }

  private candidatesKey(rideId: string, round: number): string {
    return `ride:${rideId}:round:${round}:candidates`;
  }

  /**
   * Opens a new offer round: records the candidate driver set and an expiring
   * "offer open" marker whose TTL matches the allocation timeout window. This TTL
   * is a second, independent line of defense (on top of the BullMQ delayed job)
   * against a driver accepting after the round should have expired.
   */
  async openRound(rideId: string, round: number, driverIds: string[], timeoutMs: number): Promise<void> {
    const pipeline = this.redis.pipeline();
    if (driverIds.length > 0) {
      pipeline.sadd(this.candidatesKey(rideId, round), ...driverIds);
    }
    pipeline.set(this.offerKey(rideId, round), '1', 'PX', timeoutMs);
    pipeline.expire(this.candidatesKey(rideId, round), Math.ceil((timeoutMs * 4) / 1000));
    await pipeline.exec();
  }

  /** Explicitly closes a round (used when the ride is assigned or cancelled early). */
  async closeRound(rideId: string, round: number): Promise<void> {
    await this.redis.del(this.offerKey(rideId, round));
  }

  async isRoundOpen(rideId: string, round: number): Promise<boolean> {
    const exists = await this.redis.exists(this.offerKey(rideId, round));
    return exists === 1;
  }

  /**
   * Atomically attempts to assign `driverId` as the winner for `rideId`'s current round.
   * This is the ONLY place a ride's assignment is mutated - guaranteeing exactly one
   * winner even under massively concurrent accept calls, via the Lua script's atomicity.
   */
  async acceptRide(rideId: string, round: number, driverId: string): Promise<AcceptResult> {
    const redisAny = this.redis as unknown as {
      acceptRide(assignedKey: string, offerKey: string, candidatesKey: string, driverId: string): Promise<number>;
    };
    const result = await redisAny.acceptRide(
      this.assignedKey(rideId),
      this.offerKey(rideId, round),
      this.candidatesKey(rideId, round),
      driverId,
    );
    return result as AcceptResult;
  }

  async getAssignedDriver(rideId: string): Promise<string | null> {
    return this.redis.get(this.assignedKey(rideId));
  }

  /** Cleans up all Redis state for a ride once it reaches a terminal status. */
  async cleanupRide(rideId: string, upToRound: number): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.del(this.assignedKey(rideId));
    for (let r = 1; r <= upToRound; r++) {
      pipeline.del(this.offerKey(rideId, r));
      pipeline.del(this.candidatesKey(rideId, r));
    }
    await pipeline.exec();
  }
}
