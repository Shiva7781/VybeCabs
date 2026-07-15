import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RidesService } from './rides.service';
import { RequestRideDto } from './dto/request-ride.dto';
import { AcceptRideDto } from './dto/accept-ride.dto';

@Controller('rides')
export class RidesController {
  constructor(private readonly ridesService: RidesService) {}

  @Post()
  requestRide(@Body() dto: RequestRideDto) {
    return this.ridesService.requestRide(dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ridesService.findByIdOrThrow(id);
  }

  @Post(':id/accept')
  accept(@Param('id') id: string, @Body() dto: AcceptRideDto) {
    return this.ridesService.acceptRide(id, dto.driverId);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.ridesService.cancelRide(id);
  }
}
