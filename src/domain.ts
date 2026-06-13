// src/domain.ts
import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { BankAccountState, StoredEvent, Snapshot, EventPayload } from './types';

const DEFAULT_STATE: BankAccountState = {
  accountId: '',
  ownerName: '',
  balance: 0,
  currency: 'USD',
  status: 'CLOSED',
  processedTransactionIds: [],
  lastEventNumber: 0,
};

// Apply a single event to the state
export function applyEvent(
  state: BankAccountState,
  eventType: string,
  eventData: any,
  eventNumber: number
): BankAccountState {
  const updatedState = { ...state };
  updatedState.lastEventNumber = eventNumber;

  switch (eventType) {
    case 'AccountCreated':
      updatedState.accountId = eventData.accountId;
      updatedState.ownerName = eventData.ownerName;
      updatedState.balance = Number(eventData.initialBalance);
      updatedState.currency = eventData.currency;
      updatedState.status = 'OPEN';
      updatedState.processedTransactionIds = [];
      break;

    case 'MoneyDeposited':
      updatedState.balance = Number(updatedState.balance) + Number(eventData.amount);
      if (eventData.transactionId) {
        updatedState.processedTransactionIds = [...updatedState.processedTransactionIds, eventData.transactionId];
      }
      break;

    case 'MoneyWithdrawn':
      updatedState.balance = Number(updatedState.balance) - Number(eventData.amount);
      if (eventData.transactionId) {
        updatedState.processedTransactionIds = [...updatedState.processedTransactionIds, eventData.transactionId];
      }
      break;

    case 'AccountClosed':
      updatedState.status = 'CLOSED';
      break;

    default:
      console.warn(`Unknown event type ${eventType} ignored in state reconstruction`);
      break;
  }

  return updatedState;
}

// Reconstruct account state by loading latest snapshot and replaying subsequent events
export async function loadAccount(accountId: string, client?: PoolClient): Promise<BankAccountState> {
  const queryExecutor = client || db;

  // 1. Load latest snapshot
  const snapshotRes = await queryExecutor.query(
    'SELECT * FROM snapshots WHERE aggregate_id = $1 LIMIT 1',
    [accountId]
  );

  let state = { ...DEFAULT_STATE };
  let startEventNumber = 0;

  if (snapshotRes.rows.length > 0) {
    const snapshot: Snapshot = snapshotRes.rows[0];
    state = { ...snapshot.snapshot_data };
    startEventNumber = snapshot.last_event_number;
  }

  // 2. Fetch subsequent events
  const eventsRes = await queryExecutor.query(
    'SELECT * FROM events WHERE aggregate_id = $1 AND event_number > $2 ORDER BY event_number ASC',
    [accountId, startEventNumber]
  );

  const events: StoredEvent[] = eventsRes.rows;

  // If no snapshot exists and no events exist, the account does not exist.
  if (snapshotRes.rows.length === 0 && events.length === 0) {
    throw new Error('ACCOUNT_NOT_FOUND');
  }

  // Replay events
  for (const event of events) {
    state = applyEvent(state, event.event_type, event.event_data, event.event_number);
  }

  return state;
}

// Check if an account exists
export async function accountExists(accountId: string): Promise<boolean> {
  const res = await db.query(
    'SELECT 1 FROM events WHERE aggregate_id = $1 LIMIT 1',
    [accountId]
  );
  return res.rows.length > 0;
}

// Append a new event to the event store
export async function appendEvent(
  client: PoolClient,
  accountId: string,
  expectedVersion: number,
  eventType: string,
  eventData: any
): Promise<StoredEvent> {
  const eventId = uuidv4();
  const nextEventNumber = expectedVersion + 1;

  const res = await client.query(
    `INSERT INTO events (event_id, aggregate_id, aggregate_type, event_type, event_data, event_number, timestamp, version)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), 1)
     RETURNING *`,
    [
      eventId,
      accountId,
      'BankAccount',
      eventType,
      JSON.stringify(eventData),
      nextEventNumber,
    ]
  );

  return res.rows[0];
}

// Perform snapshotting if required
export async function createSnapshotIfNeeded(
  client: PoolClient,
  state: BankAccountState,
  eventNumber: number
): Promise<void> {
  if (eventNumber % 50 === 1 && eventNumber > 1) {
    const snapshotId = uuidv4();
    await client.query(
      `INSERT INTO snapshots (snapshot_id, aggregate_id, snapshot_data, last_event_number, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (aggregate_id)
       DO UPDATE SET
         snapshot_data = EXCLUDED.snapshot_data,
         last_event_number = EXCLUDED.last_event_number,
         snapshot_id = EXCLUDED.snapshot_id,
         created_at = NOW()`,
      [snapshotId, state.accountId, JSON.stringify(state), eventNumber]
    );
    console.log(`Snapshot stored for account ${state.accountId} at event number ${eventNumber}`);
  }
}

// Reconstruct account state at a specific point in time
export async function getBalanceAtTimestamp(
  accountId: string,
  timestampStr: string
): Promise<{ accountId: string; balanceAt: number; timestamp: string }> {
  const targetDate = new Date(timestampStr);
  if (isNaN(targetDate.getTime())) {
    throw new Error('INVALID_TIMESTAMP');
  }

  // Load current to verify existence
  await loadAccount(accountId);

  // Replay from beginning up to the target timestamp
  const eventsRes = await db.query(
    'SELECT * FROM events WHERE aggregate_id = $1 AND timestamp <= $2 ORDER BY event_number ASC',
    [accountId, targetDate]
  );

  let state = { ...DEFAULT_STATE };
  const events: StoredEvent[] = eventsRes.rows;

  for (const event of events) {
    state = applyEvent(state, event.event_type, event.event_data, event.event_number);
  }

  return {
    accountId,
    balanceAt: state.balance,
    timestamp: targetDate.toISOString(),
  };
}
