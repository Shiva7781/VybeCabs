import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
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
  @HttpCode(HttpStatus.OK)
  accept(@Param('id') id: string, @Body() dto: AcceptRideDto) {
    return this.ridesService.acceptRide(id, dto.driverId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string) {
    return this.ridesService.cancelRide(id);
  }
}
