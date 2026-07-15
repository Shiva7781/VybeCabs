import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { DriverStatus } from '../../common/enums/driver-status.enum';

export type DriverDocument = Driver & Document<Types.ObjectId>;

@Schema({ _id: false })
export class GeoPoint {
  @Prop({ required: true })
  lat: number;

  @Prop({ required: true })
  lng: number;
}

@Schema({ timestamps: true })
export class Driver {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  phone: string;

  @Prop({ required: true, default: 'sedan' })
  vehicleType: string;

  @Prop({ required: true })
  licensePlate: string;

  @Prop({ type: String, enum: DriverStatus, default: DriverStatus.OFFLINE })
  status: DriverStatus;

  @Prop({ type: GeoPoint, required: false })
  location?: GeoPoint;

  @Prop()
  locationUpdatedAt?: Date;
}

export const DriverSchema = SchemaFactory.createForClass(Driver);
