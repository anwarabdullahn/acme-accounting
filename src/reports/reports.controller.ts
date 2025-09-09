/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Controller, Get, Post, HttpCode } from '@nestjs/common';
import { ReportsService } from './reports.service';

@Controller('api/v1/reports')
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

  @Get()
  report() {
    return {
      'accounts.csv': this.reportsService.state('accounts'),
      'yearly.csv': this.reportsService.state('yearly'),
      'fs.csv': this.reportsService.state('fs'),
    };
  }

  @Post()
  @HttpCode(202)
  generate() {
    setImmediate(() => {
      void this.reportsService.generateAll().catch((err) => {
        // Minimal logging; detailed handling will come in later steps
        // of the performance plan.
        // eslint-disable-next-line no-console
        console.error('Report generation failed:', err);
      });
    });
    return { message: 'started' };
  }
}
