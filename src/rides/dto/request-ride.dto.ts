import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsMongoId, IsOptional, ValidateNested } from 'class-validator';

class GeoPointDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;
}

export class RequestRideDto {
  @IsMongoId()
  riderId: string;

  @ValidateNested()
  @Type(() => GeoPointDto)
  pickup: GeoPointDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => GeoPointDto)
  dropoff?: GeoPointDto;
}
