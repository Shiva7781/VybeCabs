import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Driver, DriverDocument } from './schemas/driver.schema';
import { CreateDriverDto } from './dto/create-driver.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { DriverStatus } from '../common/enums/driver-status.enum';
import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class DriversService {
  constructor(
    @InjectModel(Driver.name) private readonly driverModel: Model<DriverDocument>,
    private readonly redisService: RedisService,
  ) {}

  async create(dto: CreateDriverDto): Promise<DriverDocument> {
    return this.driverModel.create({
      ...dto,
      vehicleType: dto.vehicleType ?? 'sedan',
      status: DriverStatus.OFFLINE,
    });
  }

  async findAll(): Promise<DriverDocument[]> {
    return this.driverModel.find().lean() as unknown as DriverDocument[];
  }

  async findByIdOrThrow(id: string): Promise<DriverDocument> {
    const driver = await this.driverModel.findById(id);
    if (!driver) {
      throw new NotFoundException(`Driver ${id} not found`);
    }
    return driver;
  }

  /**
   * Updates a driver's live position. If the driver is currently AVAILABLE this
   * is immediately reflected in the Redis GEO index used for proximity search,
   * so an in-flight or subsequent ride request sees the driver's latest location.
   */
  async updateLocation(id: string, dto: UpdateLocationDto): Promise<DriverDocument> {
    const driver = await this.findByIdOrThrow(id);
    driver.location = { lat: dto.lat, lng: dto.lng };
    driver.locationUpdatedAt = new Date();
    await driver.save();

    if (driver.status === DriverStatus.AVAILABLE) {
      await this.redisService.setDriverAvailable(id, dto.lng, dto.lat);
    }

    return driver;
  }

  /**
   * Driver-facing "go online / go offline" toggle. BUSY is a system-managed
   * status set only by the allocation engine on assignment (and cleared back to
   * AVAILABLE by the rides module) - a client cannot set it directly.
   */
  async updateStatus(id: string, status: DriverStatus): Promise<DriverDocument> {
    if (status === DriverStatus.BUSY) {
      throw new BadRequestException('BUSY is set automatically when a ride is assigned, not settable directly');
    }

    const driver = await this.findByIdOrThrow(id);
    driver.status = status;
    await driver.save();

    if (status === DriverStatus.AVAILABLE) {
      if (!driver.location) {
        throw new BadRequestException('Driver must report a location before going AVAILABLE');
      }
      await this.redisService.setDriverAvailable(id, driver.location.lng, driver.location.lat);
    } else {
      await this.redisService.removeDriverAvailability(id);
    }

    return driver;
  }

  /** Called by the allocation engine when a driver wins a ride. */
  async markBusy(id: string): Promise<void> {
    await this.driverModel.updateOne({ _id: id }, { status: DriverStatus.BUSY });
    await this.redisService.removeDriverAvailability(id);
  }

  /** Called once a driver's ride concludes (out of scope for this assignment's flow, exposed for completeness). */
  async markAvailableAgain(id: string): Promise<void> {
    const driver = await this.findByIdOrThrow(id);
    await this.driverModel.updateOne({ _id: id }, { status: DriverStatus.AVAILABLE });
    if (driver.location) {
      await this.redisService.setDriverAvailable(id, driver.location.lng, driver.location.lat);
    }
  }
}
