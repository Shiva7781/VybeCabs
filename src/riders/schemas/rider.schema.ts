import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type RiderDocument = Rider & Document<Types.ObjectId>;

@Schema({ timestamps: true })
export class Rider {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  phone: string;
}

export const RiderSchema = SchemaFactory.createForClass(Rider);
