import { IsNotEmpty, IsString } from 'class-validator';

export class CreateRiderDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  phone: string;
}
