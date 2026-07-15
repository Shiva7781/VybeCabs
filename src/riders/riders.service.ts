import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Rider, RiderDocument } from './schemas/rider.schema';
import { CreateRiderDto } from './dto/create-rider.dto';

@Injectable()
export class RidersService {
  constructor(@InjectModel(Rider.name) private readonly riderModel: Model<RiderDocument>) {}

  async create(dto: CreateRiderDto): Promise<RiderDocument> {
    return this.riderModel.create(dto);
  }

  async findAll(): Promise<RiderDocument[]> {
    return this.riderModel.find().lean() as unknown as RiderDocument[];
  }

  async findByIdOrThrow(id: string): Promise<RiderDocument> {
    const rider = await this.riderModel.findById(id);
    if (!rider) {
      throw new NotFoundException(`Rider ${id} not found`);
    }
    return rider;
  }
}
