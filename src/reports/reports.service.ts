import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import * as readline from 'readline';

@Injectable()
export class ReportsService {
  private running = false;
  private readonly logger = new Logger(ReportsService.name);
  private states: Record<
    'accounts' | 'yearly' | 'fs',
    {
      status: 'idle' | 'starting' | 'running' | 'finished' | 'error';
      startedAt?: number;
      finishedAt?: number;
      durationSec?: number;
      error?: string;
    }
  > = {
    accounts: { status: 'idle' },
    yearly: { status: 'idle' },
    fs: { status: 'idle' },
  };

  private setStatus(
    key: 'accounts' | 'yearly' | 'fs',
    patch: Partial<{
      status: 'idle' | 'starting' | 'running' | 'finished' | 'error';
      startedAt?: number;
      finishedAt?: number;
      durationSec?: number;
      error?: string;
    }>,
  ) {
    this.states[key] = { ...this.states[key], ...patch };
  }

  // Backward-compatible summary for controller GET
  state(scope: string) {
    const s = this.states[scope as 'accounts' | 'yearly' | 'fs'];
    if (!s) return 'unknown';
    if (s.status === 'finished') {
      return `finished in ${s.durationSec ?? '0.00'}`;
    }
    if (s.status === 'error') {
      return `error: ${s.error ?? 'unknown'}`;
    }
    return s.status;
  }

  // Step 1: simple entrypoint to trigger all reports.
  // This will be refactored in later steps into a single-pass,
  // streaming, non-blocking pipeline.
  async generateAll(): Promise<void> {
    if (this.running) {
      // Another run is already in progress; skip starting a new one.
      this.logger.log('Generation skipped: already running');
      return;
    }
    this.running = true;
    try {
      // Mark all as running with shared start time
      const overallStart = performance.now();
      this.setStatus('accounts', {
        status: 'running',
        startedAt: overallStart,
      });
      this.setStatus('yearly', { status: 'running', startedAt: overallStart });
      this.setStatus('fs', { status: 'running', startedAt: overallStart });
      const tmpDir = 'tmp';
      const outDir = 'out';
      const accountsFile = 'out/accounts.csv';
      const yearlyFile = 'out/yearly.csv';
      const fsFile = 'out/fs.csv';

      // Ensure output directory exists (async)
      await fsp.mkdir(outDir, { recursive: true });
      this.logger.log('Generation started');

      // Categories for FS report
      const categories = {
        'Income Statement': {
          Revenues: ['Sales Revenue'],
          Expenses: [
            'Cost of Goods Sold',
            'Salaries Expense',
            'Rent Expense',
            'Utilities Expense',
            'Interest Expense',
            'Tax Expense',
          ],
        },
        'Balance Sheet': {
          Assets: [
            'Cash',
            'Accounts Receivable',
            'Inventory',
            'Fixed Assets',
            'Prepaid Expenses',
          ],
          Liabilities: [
            'Accounts Payable',
            'Loan Payable',
            'Sales Tax Payable',
            'Accrued Liabilities',
            'Unearned Revenue',
            'Dividends Payable',
          ],
          Equity: ['Common Stock', 'Retained Earnings'],
        },
      } as const;

      const accountBalances: Record<string, number> = {};
      const cashByYear: Record<string, number> = {};
      const balances: Record<string, number> = {};

      // Initialize balances for FS categories
      for (const section of Object.values(categories)) {
        for (const group of Object.values(section)) {
          for (const account of group) {
            balances[account as keyof typeof balances] = 0;
          }
        }
      }

      // Single pass over CSV files (async streaming)
      const files = (await fsp.readdir(tmpDir)).filter(
        (file) =>
          file.endsWith('.csv') && file !== 'yearly.csv' && file !== 'fs.csv',
      );

      for (const file of files) {
        const filePath = path.join(tmpDir, file);
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({
          input: stream,
          crlfDelay: Infinity,
        });

        await new Promise<void>((resolve, reject) => {
          rl.on('line', (line: string) => {
            if (!line) return;
            const [date, account, , debit, credit] = line.split(',');
            if (!account) return;

            // Compute delta once
            const d = parseFloat(debit || '0');
            const c = parseFloat(credit || '0');
            const delta = (isNaN(d) ? 0 : d) - (isNaN(c) ? 0 : c);

            // Accounts report
            if (
              !Object.prototype.hasOwnProperty.call(accountBalances, account)
            ) {
              accountBalances[account] = 0;
            }
            accountBalances[account] += delta;

            // Yearly report (cash only)
            if (account === 'Cash') {
              // Fast path: ISO date 'YYYY-*'
              let yearKey: string;
              if (date && /^\d{4}/.test(date)) {
                yearKey = date.slice(0, 4);
              } else {
                yearKey = String(new Date(date).getFullYear());
              }
              if (!(yearKey in cashByYear)) {
                cashByYear[yearKey] = 0;
              }
              cashByYear[yearKey] += delta;
            }

            // FS report
            if (balances[account] !== undefined) {
              balances[account] += delta;
            }
          });
          rl.once('close', resolve);
          rl.once('error', reject);
        });
      }

      // Write Accounts report
      const accountsOutput = ['Account,Balance'];
      for (const [account, balance] of Object.entries(accountBalances)) {
        accountsOutput.push(`${account},${balance.toFixed(2)}`);
      }
      await fsp.writeFile(accountsFile, accountsOutput.join('\n'));

      // Write Yearly report
      const yearlyOutput = ['Financial Year,Cash Balance'];
      Object.keys(cashByYear)
        .sort()
        .forEach((year) => {
          yearlyOutput.push(`${year},${cashByYear[year].toFixed(2)}`);
        });
      await fsp.writeFile(yearlyFile, yearlyOutput.join('\n'));

      // Write FS report
      const output: string[] = [];
      output.push('Basic Financial Statement');
      output.push('');
      output.push('Income Statement');
      let totalRevenue = 0;
      let totalExpenses = 0;
      for (const account of categories['Income Statement']['Revenues']) {
        const value = balances[account] || 0;
        output.push(`${account},${value.toFixed(2)}`);
        totalRevenue += value;
      }
      for (const account of categories['Income Statement']['Expenses']) {
        const value = balances[account] || 0;
        output.push(`${account},${value.toFixed(2)}`);
        totalExpenses += value;
      }
      output.push(`Net Income,${(totalRevenue - totalExpenses).toFixed(2)}`);
      output.push('');
      output.push('Balance Sheet');
      let totalAssets = 0;
      let totalLiabilities = 0;
      let totalEquity = 0;
      output.push('Assets');
      for (const account of categories['Balance Sheet']['Assets']) {
        const value = balances[account] || 0;
        output.push(`${account},${value.toFixed(2)}`);
        totalAssets += value;
      }
      output.push(`Total Assets,${totalAssets.toFixed(2)}`);
      output.push('');
      output.push('Liabilities');
      for (const account of categories['Balance Sheet']['Liabilities']) {
        const value = balances[account] || 0;
        output.push(`${account},${value.toFixed(2)}`);
        totalLiabilities += value;
      }
      output.push(`Total Liabilities,${totalLiabilities.toFixed(2)}`);
      output.push('');
      output.push('Equity');
      for (const account of categories['Balance Sheet']['Equity']) {
        const value = balances[account] || 0;
        output.push(`${account},${value.toFixed(2)}`);
        totalEquity += value;
      }
      output.push(
        `Retained Earnings (Net Income),${(totalRevenue - totalExpenses).toFixed(2)}`,
      );
      totalEquity += totalRevenue - totalExpenses;
      output.push(`Total Equity,${totalEquity.toFixed(2)}`);
      output.push('');
      output.push(
        `Assets = Liabilities + Equity, ${totalAssets.toFixed(2)} = ${(totalLiabilities + totalEquity).toFixed(2)}`,
      );
      await fsp.writeFile(fsFile, output.join('\n'));

      const finishedAt = performance.now();
      const durationSec = Number(
        ((finishedAt - overallStart) / 1000).toFixed(2),
      );
      this.setStatus('accounts', {
        status: 'finished',
        finishedAt,
        durationSec,
      });
      this.setStatus('yearly', { status: 'finished', finishedAt, durationSec });
      this.setStatus('fs', { status: 'finished', finishedAt, durationSec });
      this.logger.log(`Generation finished in ${durationSec}s`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const finishedAt = performance.now();
      const accountsDuration = this.states.accounts.startedAt
        ? Number(
            (
              (finishedAt - (this.states.accounts.startedAt || finishedAt)) /
              1000
            ).toFixed(2),
          )
        : undefined;
      const yearlyDuration = this.states.yearly.startedAt
        ? Number(
            (
              (finishedAt - (this.states.yearly.startedAt || finishedAt)) /
              1000
            ).toFixed(2),
          )
        : undefined;
      const fsDuration = this.states.fs.startedAt
        ? Number(
            (
              (finishedAt - (this.states.fs.startedAt || finishedAt)) /
              1000
            ).toFixed(2),
          )
        : undefined;
      this.setStatus('accounts', {
        status: 'error',
        finishedAt,
        durationSec: accountsDuration,
        error: msg,
      });
      this.setStatus('yearly', {
        status: 'error',
        finishedAt,
        durationSec: yearlyDuration,
        error: msg,
      });
      this.setStatus('fs', {
        status: 'error',
        finishedAt,
        durationSec: fsDuration,
        error: msg,
      });
      this.logger.error(`Generation failed: ${msg}`);
    } finally {
      this.running = false;
    }
  }

  accounts() {
    const start = performance.now();
    this.setStatus('accounts', { status: 'running', startedAt: start });
    const tmpDir = 'tmp';
    const outputFile = 'out/accounts.csv';
    const accountBalances: Record<string, number> = {};
    fs.readdirSync(tmpDir).forEach((file) => {
      if (file.endsWith('.csv')) {
        const lines = fs
          .readFileSync(path.join(tmpDir, file), 'utf-8')
          .trim()
          .split('\n');
        for (const line of lines) {
          const [, account, , debit, credit] = line.split(',');
          if (!accountBalances[account]) {
            accountBalances[account] = 0;
          }
          accountBalances[account] +=
            parseFloat(String(debit || 0)) - parseFloat(String(credit || 0));
        }
      }
    });
    const output = ['Account,Balance'];
    for (const [account, balance] of Object.entries(accountBalances)) {
      output.push(`${account},${balance.toFixed(2)}`);
    }
    fs.writeFileSync(outputFile, output.join('\n'));
    const finishedAt = performance.now();
    const durationSec = Number(((finishedAt - start) / 1000).toFixed(2));
    this.setStatus('accounts', { status: 'finished', finishedAt, durationSec });
  }

  yearly() {
    const start = performance.now();
    this.setStatus('yearly', { status: 'running', startedAt: start });
    const tmpDir = 'tmp';
    const outputFile = 'out/yearly.csv';
    const cashByYear: Record<string, number> = {};
    fs.readdirSync(tmpDir).forEach((file) => {
      if (file.endsWith('.csv') && file !== 'yearly.csv') {
        const lines = fs
          .readFileSync(path.join(tmpDir, file), 'utf-8')
          .trim()
          .split('\n');
        for (const line of lines) {
          const [date, account, , debit, credit] = line.split(',');
          if (account === 'Cash') {
            const yearKey =
              date && /^\d{4}/.test(date)
                ? date.slice(0, 4)
                : String(new Date(date).getFullYear());
            if (!cashByYear[yearKey]) {
              cashByYear[yearKey] = 0;
            }
            cashByYear[yearKey] +=
              parseFloat(String(debit || 0)) - parseFloat(String(credit || 0));
          }
        }
      }
    });
    const output = ['Financial Year,Cash Balance'];
    Object.keys(cashByYear)
      .sort()
      .forEach((year) => {
        output.push(`${year},${cashByYear[year].toFixed(2)}`);
      });
    fs.writeFileSync(outputFile, output.join('\n'));
    const finishedAt = performance.now();
    const durationSec = Number(((finishedAt - start) / 1000).toFixed(2));
    this.setStatus('yearly', { status: 'finished', finishedAt, durationSec });
  }

  fs() {
    const start = performance.now();
    this.setStatus('fs', { status: 'running', startedAt: start });
    const tmpDir = 'tmp';
    const outputFile = 'out/fs.csv';
    const categories = {
      'Income Statement': {
        Revenues: ['Sales Revenue'],
        Expenses: [
          'Cost of Goods Sold',
          'Salaries Expense',
          'Rent Expense',
          'Utilities Expense',
          'Interest Expense',
          'Tax Expense',
        ],
      },
      'Balance Sheet': {
        Assets: [
          'Cash',
          'Accounts Receivable',
          'Inventory',
          'Fixed Assets',
          'Prepaid Expenses',
        ],
        Liabilities: [
          'Accounts Payable',
          'Loan Payable',
          'Sales Tax Payable',
          'Accrued Liabilities',
          'Unearned Revenue',
          'Dividends Payable',
        ],
        Equity: ['Common Stock', 'Retained Earnings'],
      },
    };
    const balances: Record<string, number> = {};
    for (const section of Object.values(categories)) {
      for (const group of Object.values(section)) {
        for (const account of group) {
          balances[account] = 0;
        }
      }
    }
    fs.readdirSync(tmpDir).forEach((file) => {
      if (file.endsWith('.csv') && file !== 'fs.csv') {
        const lines = fs
          .readFileSync(path.join(tmpDir, file), 'utf-8')
          .trim()
          .split('\n');

        for (const line of lines) {
          const [, account, , debit, credit] = line.split(',');

          if (Object.prototype.hasOwnProperty.call(balances, account)) {
            balances[account] +=
              parseFloat(String(debit || 0)) - parseFloat(String(credit || 0));
          }
        }
      }
    });

    const output: string[] = [];
    output.push('Basic Financial Statement');
    output.push('');
    output.push('Income Statement');
    let totalRevenue = 0;
    let totalExpenses = 0;
    for (const account of categories['Income Statement']['Revenues']) {
      const value = balances[account] || 0;
      output.push(`${account},${value.toFixed(2)}`);
      totalRevenue += value;
    }
    for (const account of categories['Income Statement']['Expenses']) {
      const value = balances[account] || 0;
      output.push(`${account},${value.toFixed(2)}`);
      totalExpenses += value;
    }
    output.push(`Net Income,${(totalRevenue - totalExpenses).toFixed(2)}`);
    output.push('');
    output.push('Balance Sheet');
    let totalAssets = 0;
    let totalLiabilities = 0;
    let totalEquity = 0;
    output.push('Assets');
    for (const account of categories['Balance Sheet']['Assets']) {
      const value = balances[account] || 0;
      output.push(`${account},${value.toFixed(2)}`);
      totalAssets += value;
    }
    output.push(`Total Assets,${totalAssets.toFixed(2)}`);
    output.push('');
    output.push('Liabilities');
    for (const account of categories['Balance Sheet']['Liabilities']) {
      const value = balances[account] || 0;
      output.push(`${account},${value.toFixed(2)}`);
      totalLiabilities += value;
    }
    output.push(`Total Liabilities,${totalLiabilities.toFixed(2)}`);
    output.push('');
    output.push('Equity');
    for (const account of categories['Balance Sheet']['Equity']) {
      const value = balances[account] || 0;
      output.push(`${account},${value.toFixed(2)}`);
      totalEquity += value;
    }
    output.push(
      `Retained Earnings (Net Income),${(totalRevenue - totalExpenses).toFixed(2)}`,
    );
    totalEquity += totalRevenue - totalExpenses;
    output.push(`Total Equity,${totalEquity.toFixed(2)}`);
    output.push('');
    output.push(
      `Assets = Liabilities + Equity, ${totalAssets.toFixed(2)} = ${(totalLiabilities + totalEquity).toFixed(2)}`,
    );
    fs.writeFileSync(outputFile, output.join('\n'));
    const finishedAt = performance.now();
    const durationSec = Number(((finishedAt - start) / 1000).toFixed(2));
    this.setStatus('fs', { status: 'finished', finishedAt, durationSec });
  }
}
