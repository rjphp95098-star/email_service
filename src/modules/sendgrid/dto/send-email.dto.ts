import {
  IsEmail,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from "class-validator";
import { Transform } from "class-transformer";

export class SendEmailDto {
  @IsEmail()
  @Transform(({ value }) => value?.trim())
  recipientEmail!: string;

  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => value?.trim())
  templateName!: string;

  @IsOptional()
  @IsObject()
  templateData?: Record<string, any>;
}