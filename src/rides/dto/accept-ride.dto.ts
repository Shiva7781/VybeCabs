import { IsMongoId } from 'class-validator';

export class AcceptRideDto {
  @IsMongoId()
  driverId: string;
}
