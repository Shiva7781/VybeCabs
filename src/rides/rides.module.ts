import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { Ride, RideSchema } from './schemas/ride.schema';
import { RidesService } from './rides.service';
import { RidesController } from './rides.controller';
import { AllocationService, ALLOCATION_TIMEOUT_QUEUE } from './allocation.service';
import { AllocationTimeoutProcessor } from './processors/allocation-timeout.processor';
import { DriversModule } from '../drivers/drivers.module';
import { RidersModule } from '../riders/riders.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Ride.name, schema: RideSchema }]),
    BullModule.registerQueue({ name: ALLOCATION_TIMEOUT_QUEUE }),
    DriversModule,
    RidersModule,
  ],
  controllers: [RidesController],
  providers: [RidesService, AllocationService, AllocationTimeoutProcessor],
  exports: [RidesService, AllocationService],
})
export class RidesModule {}
