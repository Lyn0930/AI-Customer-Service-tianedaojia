import { IsString, IsNotEmpty, IsOptional, IsEnum, ValidateIf } from 'class-validator';
import type { ServiceType, ServiceTypeGroup, LeadChannel } from '@shared/api.interface';

export class CreateLeadDto {
  @IsString()
  @IsNotEmpty()
  serviceCity!: string;

  @IsString()
  @IsNotEmpty()
  phoneNumber!: string;

  @IsString()
  @IsOptional()
  customerName?: string;

  @IsString()
  @IsOptional()
  source?: string;

  @IsString()
  @IsOptional()
  @ValidateIf((_o, v) => v !== undefined && v !== null && v !== '')
  @IsEnum(['baomu'])
  serviceTypeGroup?: ServiceTypeGroup;

  @IsString()
  @IsOptional()
  serviceType?: string;

  @IsString()
  @IsOptional()
  smsCode?: string;

  @IsString()
  @IsOptional()
  leadSourceDetail?: string;

  @IsString()
  @IsOptional()
  @ValidateIf((_o, v) => v !== undefined && v !== null && v !== '')
  @IsEnum(['openapi', 'bitable_form', 'chat', 'phone', 'manual'])
  channel?: LeadChannel;
}
