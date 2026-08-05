import { IsObject, IsOptional } from 'class-validator';

export class RunAppDto {
  /** 폼 입력값. 키는 apps.yaml 의 field.key 와 대응한다. */
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}
