import { Module } from '@nestjs/common';
import { OperatorController } from './operator.controller.js';
import { OperatorService } from './operator.service.js';

@Module({
  controllers: [OperatorController],
  providers: [OperatorService],
})
export class AppModule {}
