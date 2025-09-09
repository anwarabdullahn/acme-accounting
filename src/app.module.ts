import { Module } from '@nestjs/common';
import { DbModule } from './db.module';
import { ReportsModule } from './reports/reports.module';
import { TicketsModule } from './tickets/tickets.module';
import { HealthcheckModule } from './healthcheck/healthcheck.module';

@Module({
  imports: [DbModule, ReportsModule, TicketsModule, HealthcheckModule],
})
export class AppModule {}
