import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RidersService } from './riders.service';
import { CreateRiderDto } from './dto/create-rider.dto';

@Controller('riders')
export class RidersController {
  constructor(private readonly ridersService: RidersService) {}

  @Post()
  create(@Body() dto: CreateRiderDto) {
    return this.ridersService.create(dto);
  }

  @Get()
  findAll() {
    return this.ridersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ridersService.findByIdOrThrow(id);
  }
}
