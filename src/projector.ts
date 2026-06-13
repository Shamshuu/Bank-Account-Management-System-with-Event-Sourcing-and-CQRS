// src/projector.ts
import { EventEmitter } from 'events';
import { db } from './db';
import { StoredEvent } from './types';

// Event emitter to notify projectors of new events in real-time
export const projectionEmitter = new EventEmitter();

class ProjectorManager {
  private processing = false;
  private needsCatchUp = false;

  // Initialize and run catch-up
  async init() {
    console.log('Initializing projection manager...');
    await this.trigger();

    // Bind real-time catch-up trigger on new event writes
    projectionEmitter.on('event_appended', () => {
      this.trigger().catch((err) => console.error('Error in real-time projection trigger:', err));
    });
  }

  // Wipes all projections and resets checkpoints to re-run from first event
  async rebuild() {
    console.log('Initiating projections rebuild...');
    await db.tx(async (client) => {
      await client.query('TRUNCATE TABLE account_summaries CASCADE;');
      await client.query('TRUNCATE TABLE transaction_history CASCADE;');
      await client.query('UPDATE projection_status SET last_processed_event_number_global = 0;');
    });
    // Trigger catch-up
    await this.trigger();
  }

  // Safe wrapper to trigger catch-up, ensuring overlapping events are not missed
  async trigger() {
    this.needsCatchUp = true;
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.needsCatchUp) {
        this.needsCatchUp = false;
        await this.catchUp();
      }
    } catch (error) {
      console.error('Failed during projections catch-up loop:', error);
    } finally {
      this.processing = false;
    }
  }

  // Catch-up function to process any pending events
  private async catchUp() {
    await this.catchUpProjection('AccountSummaries', this.processAccountSummariesEvent.bind(this));
    await this.catchUpProjection('TransactionHistory', this.processTransactionHistoryEvent.bind(this));
  }

  // Get status of projections, showing processed events and lags
  async getStatus() {
    const countRes = await db.query('SELECT COUNT(*) FROM events');
    const totalEventsInStore = parseInt(countRes.rows[0].count, 10);

    const maxGlobalRes = await db.query('SELECT COALESCE(MAX(global_number), 0) AS max_val FROM events');
    const maxGlobal = parseInt(maxGlobalRes.rows[0].max_val, 10);

    const statusRes = await db.query('SELECT name, last_processed_event_number_global FROM projection_status');
    const projections = statusRes.rows.map((row) => {
      const lastProcessed = parseInt(row.last_processed_event_number_global, 10);
      return {
        name: row.name,
        lastProcessedEventNumberGlobal: lastProcessed,
        lag: Math.max(0, maxGlobal - lastProcessed),
      };
    });

    return {
      totalEventsInStore,
      projections,
    };
  }

  private async catchUpProjection(
    name: string,
    processFn: (client: any, event: StoredEvent) => Promise<void>
  ) {
    while (true) {
      // 1. Get last processed global number
      const statusRes = await db.query(
        'SELECT last_processed_event_number_global FROM projection_status WHERE name = $1',
        [name]
      );
      const lastProcessed = statusRes.rows[0] ? parseInt(statusRes.rows[0].last_processed_event_number_global, 10) : 0;

      // 2. Fetch the next event
      const nextEventRes = await db.query(
        'SELECT * FROM events WHERE global_number > $1 ORDER BY global_number ASC LIMIT 1',
        [lastProcessed]
      );
      if (nextEventRes.rows.length === 0) {
        break; // Up to date
      }

      const event: StoredEvent = nextEventRes.rows[0];

      // 3. Process the event in a transaction
      await db.tx(async (client) => {
        await processFn(client, event);
        await client.query(
          'UPDATE projection_status SET last_processed_event_number_global = $1 WHERE name = $2',
          [event.global_number, name]
        );
      });
    }
  }

  private async processAccountSummariesEvent(client: any, event: StoredEvent) {
    const { aggregate_id, event_type, event_data, event_number } = event;

    switch (event_type) {
      case 'AccountCreated':
        await client.query(
          `INSERT INTO account_summaries (account_id, owner_name, balance, currency, status, version)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (account_id) DO NOTHING`,
          [
            aggregate_id,
            event_data.ownerName,
            Number(event_data.initialBalance || 0),
            event_data.currency || 'USD',
            'OPEN',
            event_number,
          ]
        );
        break;

      case 'MoneyDeposited':
        await client.query(
          `UPDATE account_summaries
           SET balance = balance + $1, version = $2
           WHERE account_id = $3 AND version < $2`,
          [Number(event_data.amount), event_number, aggregate_id]
        );
        break;

      case 'MoneyWithdrawn':
        await client.query(
          `UPDATE account_summaries
           SET balance = balance - $1, version = $2
           WHERE account_id = $3 AND version < $2`,
          [Number(event_data.amount), event_number, aggregate_id]
        );
        break;

      case 'AccountClosed':
        await client.query(
          `UPDATE account_summaries
           SET status = 'CLOSED', version = $1
           WHERE account_id = $2 AND version < $1`,
          [event_number, aggregate_id]
        );
        break;
    }
  }

  private async processTransactionHistoryEvent(client: any, event: StoredEvent) {
    const { aggregate_id, event_type, event_data, timestamp, event_id } = event;

    switch (event_type) {
      case 'AccountCreated':
        if (event_data.initialBalance && Number(event_data.initialBalance) > 0) {
          await client.query(
            `INSERT INTO transaction_history (transaction_id, account_id, type, amount, description, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (transaction_id) DO NOTHING`,
            [
              event_id, // Fallback transaction_id
              aggregate_id,
              'DEPOSIT',
              Number(event_data.initialBalance),
              'Initial balance',
              timestamp,
            ]
          );
        }
        break;

      case 'MoneyDeposited':
        await client.query(
          `INSERT INTO transaction_history (transaction_id, account_id, type, amount, description, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (transaction_id) DO NOTHING`,
          [
            event_data.transactionId,
            aggregate_id,
            'DEPOSIT',
            Number(event_data.amount),
            event_data.description || '',
            timestamp,
          ]
        );
        break;

      case 'MoneyWithdrawn':
        await client.query(
          `INSERT INTO transaction_history (transaction_id, account_id, type, amount, description, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (transaction_id) DO NOTHING`,
          [
            event_data.transactionId,
            aggregate_id,
            'WITHDRAWAL',
            Number(event_data.amount),
            event_data.description || '',
            timestamp,
          ]
        );
        break;
    }
  }
}

export const projectorManager = new ProjectorManager();
