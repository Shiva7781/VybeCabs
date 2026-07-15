import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { RideStatus, RoundOutcome } from '../../common/enums/ride-status.enum';

export type RideDocument = Ride & Document<Types.ObjectId>;

@Schema({ _id: false })
export class GeoPoint {
  @Prop({ required: true })
  lat: number;

  @Prop({ required: true })
  lng: number;
}

@Schema({ _id: false })
export class AllocationRound {
  @Prop({ required: true })
  roundNumber: number;

  @Prop({ required: true })
  radiusKm: number;

  @Prop({ type: [String], default: [] })
  candidateDriverIds: string[];

  @Prop({ required: true })
  startedAt: Date;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: String, enum: RoundOutcome, default: RoundOutcome.PENDING })
  outcome: RoundOutcome;
}

const AllocationRoundSchema = SchemaFactory.createForClass(AllocationRound);

@Schema({ timestamps: true })
export class Ride {
  @Prop({ type: Types.ObjectId, ref: 'Rider', required: true })
  riderId: Types.ObjectId;

  @Prop({ type: GeoPoint, required: true })
  pickup: GeoPoint;

  @Prop({ type: GeoPoint, required: false })
  dropoff?: GeoPoint;

  @Prop({ type: String, enum: RideStatus, default: RideStatus.REQUESTED })
  status: RideStatus;

  @Prop({ type: Types.ObjectId, ref: 'Driver', required: false, default: null })
  assignedDriverId?: Types.ObjectId | null;

  @Prop({ default: 0 })
  currentRound: number;

  @Prop({ type: [AllocationRoundSchema], default: [] })
  rounds: AllocationRound[];

  @Prop()
  requestedAt: Date;

  @Prop()
  assignedAt?: Date;

  @Prop()
  timedOutAt?: Date;

  @Prop()
  cancelledAt?: Date;
}

export const RideSchema = SchemaFactory.createForClass(Ride);
