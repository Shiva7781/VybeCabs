import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Rider, RiderSchema } from './schemas/rider.schema';
import { RidersService } from './riders.service';
import { RidersController } from './riders.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: Rider.name, schema: RiderSchema }])],
  controllers: [RidersController],
  providers: [RidersService],
  exports: [RidersService],
})
export class RidersModule {}
