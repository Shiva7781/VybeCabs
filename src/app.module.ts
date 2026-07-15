import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import configuration, { AppConfig } from './config/configuration';
import { RedisModule } from './common/redis/redis.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RidersModule } from './riders/riders.module';
import { DriversModule } from './drivers/drivers.module';
import { RidesModule } from './rides/rides.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        uri: config.get('mongodbUri', { infer: true }),
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        connection: {
          host: config.get('redis.host', { infer: true }),
          port: config.get('redis.port', { infer: true }),
        },
      }),
    }),
    RedisModule,
    RealtimeModule,
    RidersModule,
    DriversModule,
    RidesModule,
  ],
})
export class AppModule {}
