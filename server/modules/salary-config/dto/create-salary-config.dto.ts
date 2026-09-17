import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';

const CITY_TIERS = ['一线', '二线', '三线', '二三线'] as const;
// 2026-08-15 扩列：钟点工/白班/育儿/护工/菲式 不按户型分档 → '不适用'
const AREA_TYPES = ['大面积', '小面积', '不适用'] as const;
// 2026-08-15 扩列：subDimension 空 / 8h / 24h
const SUB_DIMENSIONS = ['', '8h', '24h'] as const;

export class CreateSalaryConfigDto {
  @IsString()
  @IsNotEmpty()
  serviceType: string;

  @IsString()
  @IsIn(CITY_TIERS as unknown as string[])
  cityTier: '一线' | '二线' | '三线' | '二三线';

  @IsString()
  @IsIn(AREA_TYPES as unknown as string[])
  areaType: '大面积' | '小面积' | '不适用';

  @IsString()
  @IsOptional()
  @IsIn(SUB_DIMENSIONS as unknown as string[])
  subDimension?: '' | '8h' | '24h';

  @IsInt()
  @Min(0)
  baseLow: number;

  @IsInt()
  @Min(0)
  baseHigh: number;

  @IsInt()
  @Min(0)
  altLow: number;

  @IsInt()
  @Min(0)
  altHigh: number;
}
